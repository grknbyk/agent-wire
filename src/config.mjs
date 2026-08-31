// Everything agent-wire stores lives in one directory so a broken install can be
// inspected, backed up, or deleted as a unit.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

// Write to a sibling then rename: a config half-written by a killed setup run is
// how an install becomes unrecoverable, and rename is atomic on every platform we
// target. The temp name carries the pid so two runs cannot share it.
export function writeJson(file, value) {
    mkdirSync(HOME, { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify(value, null, 2));
    renameSync(tempFile, file);
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
