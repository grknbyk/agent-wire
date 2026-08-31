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

export function markRead(items) {
    const states = readJsonCached(paths.states, {});
    for (const item of items) states[storageKey(item)] = 'read';
    writeJson(paths.states, states);
}

export function archive(ts) {
    const states = readJsonCached(paths.states, {});
    const targets = ts
        ? readInbox().filter((item) => item.ts === ts)
        : readInbox().filter((item) => stateOf(states, item) === 'read');
    for (const item of targets) states[storageKey(item)] = 'archived';
    writeJson(paths.states, states);
    return targets.length;
}

export const findByTs = (ts) => readInbox().find((item) => item.ts === ts) ?? null;

export const readCursor = (channelId) => readJsonCached(paths.cursors, {})[channelId] ?? null;

export function writeCursor(channelId, ts) {
    const cursors = readJsonCached(paths.cursors, {});
    cursors[channelId] = ts;
    writeJson(paths.cursors, cursors);
}
