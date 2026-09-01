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
// Indented for the files a person opens when something looks wrong, packed for
// the ones only this program reads. states.json holds one entry per message ever
// received, so the indent is 800 KB of whitespace nobody will look at. The
// decision is made here, by file, rather than at each call site, so a new caller
// cannot get it wrong by leaving an argument out.
//
// ponytail: marking a page read rewrites the whole state map — 5.7ms at 20k
// messages, most of it serialising keys that did not change. That is invisible
// next to a model round-trip and it grows with history, not with traffic. If it
// ever matters, the upgrade is an append-only states.jsonl with compaction, the
// same shape inbox.jsonl already has.
const READ_BY_HUMANS = new Set([paths.config, paths.peers]);

export function writeJson(file, value) {
    mkdirSync(HOME, { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    writeFileSync(tempFile, JSON.stringify(value, null, READ_BY_HUMANS.has(file) ? 2 : 0));
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

// What a channel is allowed to do to a prompt, from least to most:
//   off   nothing about it reaches this session
//   ask   the session is told who is waiting and how many, and reads nothing
//   read  the messages themselves land in the prompt and are marked read
//
// ask is the default because it is the one that cannot surprise anybody: a count
// is a fact about the channel, while the text is somebody else's writing.
export const MODES = ['off', 'ask', 'read'];

// The mode is per session; the identity, the keys and the channel list are not.
// The client's own session id when it publishes one, and the working directory
// otherwise. Claude Code puts CLAUDE_CODE_SESSION_ID into everything it spawns —
// the MCP server, the prompt hook and the shell alike — so two windows open on one
// project finally hold different modes, which the directory alone could not do.
//
// A plain terminal has no session id and lands on the directory instead, and that
// is the feature rather than the gap: the directory entry is what a fresh session
// falls back to, so setting a mode outside the client sets the project's default.
//
// Resolved once. It ends up inside the key of every message state, so a lookup per
// key is a lookup per message, and marking fifty messages read would pay for fifty
// of them. Nothing here calls process.chdir().
// ponytail: a session entry outlives its session, so config.json collects dead
// uuids at a line each. Prune them when the file becomes annoying to read.
let resolvedScope = null;
let resolvedProject = null;

export const scopeId = () => {
    resolvedScope ??= (process.env.AGENT_WIRE_SCOPE || process.env.CLAUDE_CODE_SESSION_ID || process.cwd()).toLowerCase();
    return resolvedScope;
};

// What a session with no choice of its own falls back to.
export const projectScope = () => {
    resolvedProject ??= process.cwd().toLowerCase();
    return resolvedProject;
};

// The mode this session has chosen, or the channel's own default when it has
// chosen nothing. A channel written before modes existed carries `active`: off
// stays off, and anything else was already announcing counts without reading.
export function channelMode(config, channel, scope = scopeId()) {
    const chosen = config?.scopes?.[scope]?.[channel.name] ?? config?.scopes?.[projectScope()]?.[channel.name];
    if (MODES.includes(chosen)) return chosen;
    if (MODES.includes(channel.mode)) return channel.mode;
    return channel.active === false ? 'off' : 'ask';
}

// What this session hears about.
export const activeChannels = (config) => (config.channels ?? [])
    .filter((channel) => channelMode(config, channel) !== 'off');

// What the machine polls. One poller feeds one shared log for every session, so a
// channel stays polled while any session still wants it — `off` here means "do not
// tell me", not "stop collecting". Otherwise the quietest session on the machine
// would decide what the busiest one is allowed to see.
export function pollableChannels(config) {
    const scopes = Object.values(config.scopes ?? {});

    const isWantedBySomeone = (channel) => {
        const chosen = scopes.map((modes) => modes[channel.name]).filter((mode) => MODES.includes(mode));
        if (chosen.length === 0) return channelMode(config, channel) !== 'off';
        return chosen.some((mode) => mode !== 'off');
    };

    return (config.channels ?? []).filter(isWantedBySomeone);
}

// Switching a channel off leaves its cursor where it is, so switching it back on
// replays everything that arrived meanwhile instead of losing it.
// Returns what the channel was as well as what it is now, so the caller can say
// "this replays what you missed" only when something was actually missed.
export function setChannelMode(name, mode) {
    const config = loadConfig();
    if (!config) return null;

    const channel = findChannel(config, name);
    if (!channel) return null;

    const previous = channelMode(config, channel);
    const scopes = config.scopes ?? {};
    scopes[scopeId()] = { ...scopes[scopeId()], [channel.name]: mode };
    config.scopes = scopes;
    saveConfig(config);
    return { channel, previous };
}

export function findChannel(config, wanted) {
    if (!wanted) return defaultChannel(config);
    const name = String(wanted).replace(/^#/, '').toLowerCase();
    return config.channels?.find((c) => c.name.toLowerCase() === name || c.id === wanted) ?? null;
}
