// The local log is the source of truth, not the Slack channel. Slack history is a
// cache we can re-read at any time, so a full re-scan is an ordinary idempotent
// operation rather than a recovery procedure.
//
// inbox.jsonl is append-only and keyed by the Slack timestamp, which is unique per
// channel and survives a re-install. Message state lives in a separate file so the
// append-only log never has to be rewritten in place.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

import { HOME, derivedFromFile, paths, readJsonCached, scopeId, writeJson } from './config.mjs';

// Enough to catch up on a conversation, short enough not to bury the session that
// asked. A caller that wants the whole log passes its own count.
export const DEFAULT_COUNT = 20;

// Two keys, because the log and the reading of it have different owners. The log
// is shared: one poller writes one copy of each message, and this is what stops it
// writing a second.
const logKey = (item) => `${item.channel}:${item.ts}`;

// Read and unread are per session, because the modes are. One session set to
// `read` opens everything it is given; if that also marked the message read for
// the session next door, an `ask` session would report an empty inbox forever.
const storageKey = (item) => `${scopeId()}|${logKey(item)}`;

// Parsed at most once per write. Four call sites read the whole log — select,
// append, archive, findByTs — and a poll runs several of them back to back, so
// without this a 20k-message log is parsed four times to answer one question.
export function readInbox() {
    if (!existsSync(paths.inbox)) return [];
    return derivedFromFile(paths.inbox, 'parsed', () => readFileSync(paths.inbox, 'utf8')
        .split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean));
}

// The dedup check is a lookup, so it is stored as one. Rebuilding a 20k-entry Set
// per appended message is the whole cost of appending a message.
const inboxKeys = () => derivedFromFile(paths.inbox, 'keys', () => new Set(readInbox().map(logKey)));

export const stateOf = (states, item) => states[storageKey(item)] ?? 'unread';

// The Slack timestamp is the idempotency key: a retried poll, an overlapping
// window, or a re-installed app all replay the same ts, and a duplicate the human
// has to clean up by hand is the failure that generates support noise.
export function appendMessages(items) {
    if (items.length === 0) return 0;

    const seen = inboxKeys();
    const fresh = items.filter((item) => !seen.has(logKey(item)));
    if (fresh.length === 0) return 0;

    mkdirSync(HOME, { recursive: true });
    appendFileSync(paths.inbox, fresh.map((item) => JSON.stringify(item)).join('\n') + '\n');
    return fresh.length;
}

// `channel` names one channel explicitly and overrides everything. `channels`
// is the caller's allow-list, which is how switched-off channels stay out of the
// default view without being deleted from the log.
export function selectMessages({ state = 'unread', count = DEFAULT_COUNT, channel = null, channels = null } = {}) {
    const states = readJsonCached(paths.states, {});
    const isVisible = (item) => {
        if (channel) return item.channel === channel;
        if (channels) return channels.includes(item.channel);
        return true;
    };

    // Scanned from the newest end and stopped at `count`. Filtering the whole log
    // to keep the last twenty of it was most of what reading an inbox cost, and
    // the log only grows.
    const log = readInbox();
    const picked = [];
    for (let index = log.length - 1; index >= 0 && picked.length < count; index--) {
        const item = log[index];
        if (!isVisible(item)) continue;
        if (state !== 'all' && stateOf(states, item) !== state) continue;
        picked.push(item);
    }
    return picked.reverse();
}

// A session id is minted per client session, so read state stored under one is
// unreachable the moment that session ends — no later process ever asks under
// that key again. Left alone the file grows by one key per message per session:
// measured at 14 MB and 79 ms per mark after a thousand sessions, and marking is
// something a `read` session does on every prompt.
//
// Whole scopes go, oldest first, ranked by the newest message each one has seen.
// A session still running has recent timestamps and survives; only the dead ones
// are cheap enough to lose. The current scope is never a candidate.
const STATE_KEYS_MAX = 8000;
const STATE_KEYS_KEEP = 6000;

const scopeOfKey = (key) => {
    const bar = key.indexOf('|');
    return bar === -1 ? '' : key.slice(0, bar); // written before scopes existed
};

function prunedStates(states) {
    const keys = Object.keys(states);
    if (keys.length <= STATE_KEYS_MAX) return states;

    // One session that has simply read a lot owns every key here, and none of them
    // can be dropped. Counting them costs a startsWith per key and no allocation,
    // where grouping by scope costs a substring per key: 20k keys went from 0.7 ms
    // to 13 ms of scanning that always freed nothing.
    const mine = `${scopeId()}|`;
    let foreign = 0;
    for (const key of keys) if (!key.startsWith(mine)) foreign++;
    if (foreign === 0) return states;

    const keysByScope = new Map();
    const newestByScope = new Map();
    for (const key of keys) {
        const scope = scopeOfKey(key);
        const timestamp = Number(key.slice(key.lastIndexOf(':') + 1)) || 0;
        if (!keysByScope.has(scope)) keysByScope.set(scope, []);
        keysByScope.get(scope).push(key);
        if (timestamp > (newestByScope.get(scope) ?? 0)) newestByScope.set(scope, timestamp);
    }

    const stale = [...newestByScope]
        .filter(([scope]) => scope !== scopeId())
        .sort(([, left], [, right]) => left - right);

    // Down to the low mark rather than to the cap, or the next write is over it
    // again and pays for the whole scan a second time.
    let remaining = keys.length;
    for (const [scope] of stale) {
        if (remaining <= STATE_KEYS_KEEP) break;
        for (const key of keysByScope.get(scope)) delete states[key];
        remaining -= keysByScope.get(scope).length;
    }
    return states;
}

export function markRead(items) {
    const states = readJsonCached(paths.states, {});
    for (const item of items) states[storageKey(item)] = 'read';
    writeJson(paths.states, prunedStates(states));
}

export function archive(ts) {
    const states = readJsonCached(paths.states, {});
    const targets = ts
        ? readInbox().filter((item) => item.ts === ts)
        : readInbox().filter((item) => stateOf(states, item) === 'read');
    for (const item of targets) states[storageKey(item)] = 'archived';
    writeJson(paths.states, prunedStates(states));
    return targets.length;
}

export const findByTs = (ts) => readInbox().find((item) => item.ts === ts) ?? null;

export const readCursor = (channelId) => readJsonCached(paths.cursors, {})[channelId] ?? null;

export function writeCursor(channelId, ts) {
    const cursors = readJsonCached(paths.cursors, {});
    cursors[channelId] = ts;
    writeJson(paths.cursors, cursors);
}
