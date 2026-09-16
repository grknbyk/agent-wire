// One process, and only this one, asks Slack for incoming messages. Everything on
// the read path — the MCP server, the prompt hook, the inbox tool — reads the local
// log this writes. That is the whole point: a slow or rate-limited Slack can no
// longer make a prompt wait. Measured before the split, the round trip was 343 ms
// of drain's 485 ms, spent re-fetching what was already on disk.
//
// The price is staleness, bounded by sync_seconds. A ref lookup is the one read
// that still reaches Slack, and only when the log does not have that handle.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, paths, pollableChannels } from './config.mjs';
import { appendMessages, readCursor, writeCursor } from './inbox.mjs';
import { splitHandle } from './protocol.mjs';
import { CHANNEL_CONCURRENCY, mapLimit, pollChannel, slackClient } from './slack.mjs';

// Nothing waits on a sync, so this number only decides how stale the log may be.
// The floor is what stops a typo in config.json from hammering a workspace the
// whole team shares on one token.
const SYNC_SECONDS_DEFAULT = 60;
const SYNC_SECONDS_MIN = 5;

export function syncEveryMs(config) {
    const wanted = Number(config?.sync_seconds);
    const seconds = Number.isFinite(wanted) && wanted > 0 ? wanted : SYNC_SECONDS_DEFAULT;
    return Math.max(SYNC_SECONDS_MIN, seconds) * 1000;
}

// The channels are fetched together and written afterwards, in order. Awaiting
// one channel before starting the next spent a round trip per channel on data
// that has nothing to do with the previous answer. Writing afterwards also means
// no two channels interleave a read-modify-write of the same log.
//
// A channel that throws is caught here rather than at the caller, so one broken
// channel costs its own messages instead of everybody else's.
export async function pollOnce(config, { budgetMs = null } = {}) {
    const channels = pollableChannels(config);
    const deadline = budgetMs ? Date.now() + budgetMs : null;
    const client = slackClient(config.bot_token, { deadline });
    const polled = await mapLimit(channels, CHANNEL_CONCURRENCY, (channel) =>
        pollChannel(client, channel, { since: readCursor(channel.id), myNickname: config.nickname, deadline })
            .catch((error) => ({ ok: false, reason: error.message, items: [] })));

    let added = 0;
    let refused = null;
    for (const [index, result] of polled.entries()) {
        if (!result.ok) {
            // Reported rather than swallowed. The syncer decides how fast to come
            // back, and it cannot decide that without knowing it was turned away.
            refused ??= result.reason ?? 'unknown';
            continue;
        }

        added += appendMessages(result.items);
        if (result.newest) writeCursor(channels[index].id, result.newest);
    }
    return { added, refused };
}

// Slack refuses a whole workspace at once, so every machine's syncer is turned away
// in the same second and, on a fixed interval, comes back in the same second too —
// which is how a rate limit stays hit. Doubling on refusal thins the traffic, and
// the jitter stops the fleet re-forming into one synchronised wave on the way back
// up. Success returns to base immediately: the backoff is for the outage, not a
// punishment that outlives it.
const BACKOFF_MAX_MS = 10 * 60 * 1000;
const JITTER = 0.25;

export const nextDelay = ({ previous, base, refused }) =>
    (refused ? Math.min(Math.max(previous, base) * 2, BACKOFF_MAX_MS) : base);

const withJitter = (ms) => Math.round(ms * (1 + ((Math.random() * 2) - 1) * JITTER));

// poll.lock is the heartbeat, and it ticks far faster than a sync cycle so that a
// crashed syncer is noticed in seconds rather than in one sync_seconds. The pid in
// it is for the startup race below and nothing else: pid reuse lies, a timestamp
// does not, so liveness is decided on the timestamp alone.
const HEARTBEAT_MS = 10000;
const HEARTBEAT_STALE_MS = 30000;
const LOCK_SETTLE_MS = 250;

const beat = () => writeFileSync(paths.pollLock, `${process.pid}:${Date.now()}`);
const lockHolder = () => (existsSync(paths.pollLock) ? readFileSync(paths.pollLock, 'utf8') : '').trim().split(':');

// No lock file at all gives NaN here, and NaN is not less than anything, so the
// answer is no.
export function syncerIsLive() {
    const [, at] = lockHolder();
    return Date.now() - Number(at) < HEARTBEAT_STALE_MS;
}

// Returns a reason when it declines to start. Otherwise it does not return in any
// useful sense: the two intervals are what hold the process open.
export async function syncLoop() {
    if (syncerIsLive()) return 'a syncer is already running';

    const config = loadConfig();
    if (!config) return 'not set up yet — run \`agent-wire setup\`';

    beat();
    // Two prompts can notice a dead syncer in the same instant and both spawn one.
    // Last writer keeps the lock and the loser leaves, rather than two syncers
    // doubling the request rate against a workspace the whole team shares.
    await new Promise((done) => setTimeout(done, LOCK_SETTLE_MS));
    if (lockHolder()[0] !== String(process.pid)) return 'another syncer claimed the lock first';

    setInterval(beat, HEARTBEAT_MS);

    // Config is re-read every cycle, so a channel added by setup and a changed
    // sync_seconds are both picked up without a restart.
    //
    // Each tick schedules the next one instead of an interval firing regardless.
    // A tick that runs long then delays its successor rather than stacking on top
    // of it, which matters most exactly when Slack is slow.
    let wait = syncEveryMs(config);

    const tick = async () => {
        try {
            const fresh = loadConfig() ?? config;
            const { refused } = await pollOnce(fresh).catch((error) => ({ added: 0, refused: error.message }));
            // Offline, rate limited, or one bad channel. Never fatal: a syncer that
            // exits on a bad network is a syncer nobody can rely on.
            wait = nextDelay({ previous: wait, base: syncEveryMs(fresh), refused });
        } catch (error) {
            // Something outside the poll threw — a half-written config.json is the
            // realistic one. Treated as a refusal so the retry slows down instead of
            // spinning on the same broken file.
            wait = nextDelay({ previous: wait, base: wait, refused: error.message });
        } finally {
            // In `finally` because each tick owns the next one. An interval kept
            // firing whatever happened; a chain that throws before this line is a
            // syncer that heartbeats forever and never syncs again.
            setTimeout(tick, withJitter(wait));
        }
    };

    await tick();
    return null;
}

// How long a handle is worth chasing. A person pasting one means "this line, here",
// so the sweep is bounded by the clock rather than by pages: an answer that arrives
// in two minutes is not an answer.
//
// 25 seconds because Slack answers a refused history call with retry-after: 10, and
// a budget under that buys exactly one attempt. A lookup a human asked for can
// afford to sit out one cooldown.
const REF_SEARCH_MS = 25000;

// The only read that goes to Slack, and only after the log has been tried. A handle
// a human copied out of the channel is regularly older than this install's log — a
// fresh clone has no log at all — and "I do not have it" is a poor answer when the
// message is one request away.
// Answers { item, blocked }. `blocked` carries Slack's own word for why it would
// not answer — `ratelimited` is the common one — because "the channel does not have
// it" and "the channel would not say" are different answers and only one of them is
// safe to report as an absence.
export async function fetchByRef(config, handle) {
    const { channel: named, ref } = splitHandle(handle);
    const channels = pollableChannels(config).filter((channel) => !named || channel.name.toLowerCase() === named);
    const deadline = Date.now() + REF_SEARCH_MS;
    const client = slackClient(config.bot_token, { deadline });
    let blocked = null;

    for (const channel of channels) {
        // `since` is deliberately null. The handle being missing from the log is
        // itself the evidence that it sits behind the cursor. Attachments are not
        // pulled on this path: a deadline is set and pollChannel reads that as being
        // in a hurry, so a found message names its file without the bytes.
        const swept = await pollChannel(client, channel, { since: null, myNickname: config.nickname, deadline })
            .catch((error) => ({ ok: false, reason: error.message, items: [] }));
        if (!swept.ok) {
            blocked = swept.reason ?? 'unknown';
            continue;
        }

        const found = swept.items.filter((item) => item.ref === ref).at(-1);
        if (!found) continue;

        // Only the match is written. Filing the whole sweep would drop a thousand
        // old messages into the log as unread and bury the next prompt in them.
        appendMessages([found]);
        return { item: found, blocked: null };
    }
    return { item: null, blocked };
}

// For anything that needs the log current but must not wait for Slack. Detached
// and silent on purpose: the caller is a prompt hook or an MCP server that exits
// in a moment, and an inherited pipe nobody drains would wedge the child.
export function ensureSyncer() {
    if (syncerIsLive()) return false;

    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wire.mjs');
    spawn(process.execPath, [cli, 'sync'], { detached: true, stdio: 'ignore' }).unref();
    return true;
}
