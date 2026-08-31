// Everything agent-wire stores lives in one directory so a broken install can be
// inspected, backed up, or deleted as a unit.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.AGENT_WIRE_HOME || join(homedir(), '.agent-wire');

export const paths = {
    config: join(HOME, 'config.json'),
    inbox: join(HOME, 'inbox.jsonl'),
    states: join(HOME, 'states.json'),
    cursors: join(HOME, 'cursors.json'),
    peers: join(HOME, 'peers.json'),
    users: join(HOME, 'users.json'),
    files: join(HOME, 'files'),
    pollLock: join(HOME, 'poll.lock'),
};

export const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

// mtime and size together, or null when the file is not there yet. Both move on
// every write, and they move for a write from any process, which is what makes
// this safe to cache on: the poller and three agent sessions all share these
// files and none of them can tell the others it wrote.
function stampOf(file) {
    try {
        const stat = statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
    } catch {
        return null;
    }
}

const parsedByFile = new Map();

// Re-parsing states.json on every message is most of what reading an inbox costs
// once a log gets long, and the parse is pure waste when nothing wrote in
// between. Callers get the cached object itself, not a copy — every caller here
// either only reads it, or mutates it and writes immediately after.
export function readJsonCached(file, fallback) {
    const stamp = stampOf(file);
    if (!stamp) return fallback;

    const cached = parsedByFile.get(file);
    if (cached && cached.stamp === stamp) return cached.value;

    const value = JSON.parse(readFileSync(file, 'utf8'));
    parsedByFile.set(file, { stamp, value });
    return value;
}

// Cache anything else derived from one file's contents — a parsed log, an index
// built from it — under the same stamp, so it is thrown away exactly when the
// parse behind it is.
export function derivedFromFile(file, key, build) {
    const stamp = stampOf(file);
    const cacheKey = `${file}#${key}`;
    const cached = parsedByFile.get(cacheKey);
    if (cached && cached.stamp === stamp) return cached.value;

    const value = build();
    parsedByFile.set(cacheKey, { stamp, value });
    return value;
}

// Write to a sibling then rename: a config half-written by a killed setup run is
// how an install becomes unrecoverable, and rename is atomic on every platform we
// target. The temp name carries the pid so two runs cannot share it.
export function writeJson(file, value) {
    mkdirSync(HOME, { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify(value, null, 2));
    renameSync(tempFile, file);
    parsedByFile.set(file, { stamp: stampOf(file), value });
}

export const loadConfig = () => readJson(paths.config, null);

export const saveConfig = (config) => writeJson(paths.config, config);

// Setup writes after every completed step, so the config IS the resume state and
// there is no second progress file to disagree with it.
export function patchConfig(patch) {
    const merged = { ...(loadConfig() ?? { version: 1 }), ...patch };
    saveConfig(merged);
    return merged;
}

export const defaultChannel = (config) => config.channels?.[0] ?? null;

// A channel is active unless it was explicitly switched off, so a config written
// before this option existed keeps every channel on.
export const activeChannels = (config) => (config.channels ?? []).filter((channel) => channel.active !== false);

// Switching a channel off leaves its cursor where it is, so switching it back on
// replays everything that arrived meanwhile instead of losing it.
export function setChannelActive(name, active) {
    const config = loadConfig();
    if (!config) return null;

    const channel = findChannel(config, name);
    if (!channel) return null;

    channel.active = active;
    saveConfig(config);
    return channel;
}

export function findChannel(config, wanted) {
    if (!wanted) return defaultChannel(config);
    const name = String(wanted).replace(/^#/, '').toLowerCase();
    return config.channels?.find((c) => c.name.toLowerCase() === name || c.id === wanted) ?? null;
}
