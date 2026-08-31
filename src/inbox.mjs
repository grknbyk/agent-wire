// The local log is the source of truth, not the Slack channel. Slack history is a
// cache we can re-read at any time, so a full re-scan is an ordinary idempotent
// operation rather than a recovery procedure.
//
// inbox.jsonl is append-only and keyed by the Slack timestamp, which is unique per
// channel and survives a re-install. Message state lives in a separate file so the
// append-only log never has to be rewritten in place.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

import { HOME, paths, readJson, writeJson } from './config.mjs';

const storageKey = (item) => `${item.channel}:${item.ts}`;

export function readInbox() {
    if (!existsSync(paths.inbox)) return [];
    return readFileSync(paths.inbox, 'utf8').split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

export const stateOf = (states, item) => states[storageKey(item)] ?? 'unread';

// The Slack timestamp is the idempotency key: a retried poll, an overlapping
// window, or a re-installed app all replay the same ts, and a duplicate the human
// has to clean up by hand is the failure that generates support noise.
export function appendMessages(items) {
    if (items.length === 0) return 0;

    const seen = new Set(readInbox().map(storageKey));
    const fresh = items.filter((item) => !seen.has(storageKey(item)));
    if (fresh.length === 0) return 0;

    mkdirSync(HOME, { recursive: true });
    appendFileSync(paths.inbox, fresh.map((item) => JSON.stringify(item)).join('\n') + '\n');
    return fresh.length;
}

// `channel` names one channel explicitly and overrides everything. `channels`
// is the caller's allow-list, which is how switched-off channels stay out of the
// default view without being deleted from the log.
export function selectMessages({ state = 'unread', count = 20, channel = null, channels = null } = {}) {
    const states = readJson(paths.states, {});
    const visible = readInbox().filter((item) => {
        if (channel) return item.channel === channel;
        if (channels) return channels.includes(item.channel);
        return true;
    });
    const wanted = state === 'all' ? visible : visible.filter((item) => stateOf(states, item) === state);
    return wanted.slice(-count);
}

export function markRead(items) {
    const states = readJson(paths.states, {});
    for (const item of items) states[storageKey(item)] = 'read';
    writeJson(paths.states, states);
}

export function archive(ts) {
    const states = readJson(paths.states, {});
    const targets = ts
        ? readInbox().filter((item) => item.ts === ts)
        : readInbox().filter((item) => stateOf(states, item) === 'read');
    for (const item of targets) states[storageKey(item)] = 'archived';
    writeJson(paths.states, states);
    return targets.length;
}

export const findByTs = (ts) => readInbox().find((item) => item.ts === ts) ?? null;

export const readCursor = (channelId) => readJson(paths.cursors, {})[channelId] ?? null;

export function writeCursor(channelId, ts) {
    const cursors = readJson(paths.cursors, {});
    cursors[channelId] = ts;
    writeJson(paths.cursors, cursors);
}
