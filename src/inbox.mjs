// The local log is the source of truth, not the Slack channel. Slack history is a
// cache we can re-read at any time, so a full re-scan is an ordinary idempotent
// operation rather than a recovery procedure.
//
// inbox.jsonl is append-only and keyed by the Slack timestamp, which is unique per
// channel and survives a re-install. Message state lives in a separate file so the
// append-only log never has to be rewritten in place.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';

import { HOME, derivedFromFile, paths, readJson, readJsonCached, scopeId, updateJson, withLock, writeJson } from './config.mjs';
import { splitHandle } from './protocol.mjs';

// Five at a time (owner, 12.11): an agent reads the newest and goes further back only when it
// needs to, so an old message is not pulled into a context that did not ask for it.
export const DEFAULT_COUNT = 5;

// Two keys, because the log and the reading of it have different owners. The log
// is shared: one poller writes one copy of each message, and this is what stops it
// writing a second.
const logKey = (item) => `${item.channel}:${item.ts}`;

// Read and unread are per session, because the modes are. One session set to
// `read` opens everything it is given; if that also marked the message read for
// the session next door, an `ask` session would report an empty inbox forever.
const storageKey = (item) => `${scopeId()}|${logKey(item)}`;

// The one key of a session that is not a message: where its log began (sessionStart).
const SINCE = '|since';

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

// A message this agent sent is kept in the log so the conversation reads back
// whole, but it was never waiting on anybody. Left as unread it joined the tally
// of who needs an answer, and the agent was told ten people were waiting when one
// of them was itself.
export const stateOf = (states, item) =>
    (item.authorship === 'self' ? 'read' : states[storageKey(item)] ?? 'unread');

// The Slack timestamp is the idempotency key: a retried poll, an overlapping
// window, or a re-installed app all replay the same ts, and a duplicate the human
// has to clean up by hand is the failure that generates support noise.
// Under the lock, because the check and the append are two steps. A handle
// sweep and the syncer can reach the same message at the same moment, and both
// would see it missing and both would write it.
export function appendMessages(items) {
    if (items.length === 0) return 0;

    return withLock(paths.inbox, () => {
        const seen = inboxKeys();
        const fresh = items.filter((item) => !seen.has(logKey(item)));
        if (fresh.length === 0) return 0;

        mkdirSync(HOME, { recursive: true });
        appendFileSync(paths.inbox, fresh.map((item) => JSON.stringify(item)).join('\n') + '\n');
        return fresh.length;
    });
}

// `channel` names one channel explicitly and overrides everything. `channels`
// is the caller's allow-list, which is how switched-off channels stay out of the
// default view without being deleted from the log.
//
// `before` is the ts of the oldest message of the page already read. The next page starts at
// the log line under it, not at a smaller ts: the log is in arrival order, two channels
// interleave in it, and a page cut by ts would step over a message that arrived out of order.
// `older` says whether one more message of the same kind lies beyond the page.
// `from` is the first log line the caller takes: a prompt hook stops where its session started.
export function selectPage({ state = 'unread', count = DEFAULT_COUNT, channel = null, channels = null, before = null, from = 0 } = {}) {
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
    let older = false;
    const newest = before === null ? log.length - 1 : log.findLastIndex((item) => item.ts === before) - 1;
    for (let index = newest; index >= from; index--) {
        const item = log[index];
        if (!isVisible(item)) continue;
        if (state !== 'all' && stateOf(states, item) !== state) continue;
        if (picked.length === count) {
            older = true;
            break;
        }
        picked.push(item);
    }
    return { items: picked.reverse(), older };
}

export const selectMessages = (options) => selectPage(options).items;

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
    const separator = key.indexOf('|');
    return separator === -1 ? '' : key.slice(0, separator); // written before scopes existed
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
        // A session's start mark names its log line in the value; every other key carries its own.
        const dated = key.endsWith(SINCE) ? String(states[key]) : key;
        const timestamp = Number(dated.slice(dated.lastIndexOf(':') + 1)) || 0;
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

export const markRead = (items) => updateJson(paths.states, {}, (states) => {
    for (const item of items) states[storageKey(item)] = 'read';
    return prunedStates(states);
});

// A session is given what arrives after it started, not the log it was born into: a new session
// used to read the whole backlog into its prompts, fifty messages at a time (owner, 13.11). The
// mark is the last log line of the time before: the newest one this session has read, or the end
// of the log for a session that has read nothing. It is kept with the read states, so it is
// pruned with them. `earlier` counts the unread before the mark, once, when the mark is set.
export function sessionStart(channels) {
    const key = `${scopeId()}${SINCE}`;
    const states = readJsonCached(paths.states, {});
    const log = readInbox();
    const marked = states[key] === undefined ? -1 : log.findLastIndex((item) => logKey(item) === states[key]);
    if (marked !== -1 || states[key] === '') return { from: marked + 1, earlier: 0 };

    const lastRead = log.findLastIndex((item) => states[storageKey(item)] === 'read');
    const last = lastRead === -1 ? log.length - 1 : lastRead;
    const earlier = log.slice(0, last + 1).filter((item) => channels.includes(item.channel) && stateOf(states, item) === 'unread').length;
    updateJson(paths.states, {}, (all) => prunedStates({ ...all, [key]: last === -1 ? '' : logKey(log[last]) }));
    return { from: last + 1, earlier };
}

// withLock rather than updateJson, because the answer is how many were
// archived, not the map that was written.
export const archive = (ts) => withLock(paths.states, () => {
    const states = readJson(paths.states, {});
    const targets = ts
        ? readInbox().filter((item) => item.ts === ts)
        : readInbox().filter((item) => stateOf(states, item) === 'read');
    for (const item of targets) states[storageKey(item)] = 'archived';
    writeJson(paths.states, prunedStates(states));
    return targets.length;
});

export const findByTs = (ts) => readInbox().find((item) => item.ts === ts) ?? null;

// Newest first: a ref is short enough to collide eventually, and the one a person
// just read off the channel is the recent one.
export function findByRef(handle) {
    const { channel, ref } = splitHandle(handle);
    return readInbox()
        .filter((item) => item.ref === ref && (!channel || item.channel === channel))
        .at(-1) ?? null;
}

// cursors.json is the one file whose loss costs nothing: without a cursor a poll
// reads the newest page again and the log's ts key drops the repeats. One found
// full of NUL bytes after an interrupted write threw out of every poll for four
// weeks, so a file that does not parse is moved aside and read as empty.
function cursors() {
    try {
        return readJsonCached(paths.cursors, {});
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        renameSync(paths.cursors, `${paths.cursors}.corrupt-${Date.now()}`);
        return {};
    }
}

export const readCursor = (channelId) => cursors()[channelId] ?? null;

export const writeCursor = (channelId, ts) => {
    cursors(); // updateJson's own read would throw on a corrupt file
    return updateJson(paths.cursors, {}, (all) => {
        all[channelId] = ts;
        return all;
    });
};
