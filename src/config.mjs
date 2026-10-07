// Everything agent-wire stores lives in one directory so a broken install can be
// inspected, backed up, or deleted as a unit.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
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
    update: join(HOME, 'update.json'),
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


// Every file here is written by several processes at once: one MCP server per
// session, the syncer, the prompt hook on every prompt, and the CLI. writeJson
// is atomic by itself, temp file then rename, but read-change-write is not, and
// the losing writer's change simply vanished. Four processes marking 200
// messages read each kept 226 of 800. On Windows it is worse than silent:
// renaming onto a file another process holds open throws EPERM, so markRead
// threw, and a send that had already reached Slack came back as a failure.
//
// The wait has to outlast the longest section anybody legitimately holds, not
// the staleness window. archive() with no ts reads all of inbox.jsonl and
// rewrites a states map of thousands of keys, which this file's own measurement
// puts in seconds on a large log, and a waiter that gives up before that throws
// out of appendMessages after the message has already reached Slack. That is
// the failure at the top of this comment, arriving by a different road. Ten
// seconds is also the ceiling on how long pause() blocks the event loop, which
// is the price of the guarantee.
//
// LOCK_REUSED_MS is the last resort, and it is deliberately far longer than any
// section: it can only be reached by a holder wedged for ten minutes, which
// means suspended or stopped under a debugger rather than working.
const LOCK_STALE_MS = 1000;
const LOCK_REUSED_MS = 600000;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_MS = 5;

// Which files this process holds right now. withLock is synchronous end to end,
// so a second call for a file already held could only come from a work()
// callback, and that is a bug worth hearing about: the inner call would reclaim
// the outer's lock, both frames would run inside the section, and the inner
// release would hand the lock away while the outer still believed it held it.
const heldHere = new Set();
let acquisitions = 0;

// Everything on this path is synchronous and Node has no sleep. Atomics.wait on
// a buffer nobody ever wakes is the one way to pause without an event loop turn.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Whether the lock in front of us is abandoned. Getting this wrong in either
// direction costs something: say gone of a live holder and two writers run the
// same read-change-write, which is the lost update this file exists to stop; say
// held of a dead one and the file is locked out for good.
//
// Age cannot be the answer on its own. The mtime is stamped once, when the lock
// is taken, so it measures how long the section has been running and not how
// long ago the holder died.
const holderIsGone = (lockFile) => {
    let pid;
    let mtimeMs;
    try {
        pid = Number.parseInt(readFileSync(lockFile, 'utf8'), 10);
        mtimeMs = statSync(lockFile).mtimeMs;
    } catch {
        return false; // released between the failed open and this read
    }
    const age = Date.now() - mtimeMs;

    // Our own pid can only be our own leftover, from a release whose delete
    // failed, because withLock is synchronous and re-entry throws before it gets
    // here. kill would answer that we are alive, which is true and useless, and
    // the process would then throw on every later use of that file for as long
    // as it ran.
    if (pid === process.pid) return !heldHere.has(lockFile);

    // Empty, because we caught the holder between the create and the stamp.
    if (Number.isNaN(pid)) return age > LOCK_STALE_MS;

    // A lock written before this boot cannot be held by anything now running,
    // whatever its pid says. The file outlives the machine, and after a restart
    // the number in it belongs to somebody unrelated: Windows hands low pids out
    // again quickly, and kill answers EPERM rather than ESRCH for a process
    // owned by another user, so both of those read as alive. This is the one test
    // here with no false positive in it, which is why it comes before kill.
    if (mtimeMs < Date.now() - uptime() * 1000) return true;

    try {
        process.kill(pid, 0);
    } catch (error) {
        return error.code === 'ESRCH';
    }

    // Alive, as far as kill can tell. Within one boot a pid can still be reused
    // by something unrelated, and nothing above catches that, so a lock held far
    // longer than any real section is taken anyway.
    return age > LOCK_REUSED_MS;
};

// Renaming is the only way to take an abandoned lock without two processes
// taking it together. Check, delete, create is three steps, and a second waiter
// that checked before the winner's delete and deleted after the winner's create
// ended up inside the section with it: four processes racing an already-stale
// lock overlapped on 2 of 25 rounds. Exactly one rename can win, and only the
// winner may delete. On Windows the rename also fails while the holder still has
// the file open, which is the answer we want anyway.
const reclaim = (lockFile, stamp) => {
    // A name of its own for every attempt. Sharing one per process meant that a
    // grave we failed to delete sat in the way of our own next reclaim, because
    // renaming onto a file that will not go away fails too, and that one process
    // could then never take that lock again.
    const grave = `${lockFile}.${stamp.split(' ')[1]}.dead`;
    try {
        renameSync(lockFile, grave);
    } catch {
        return false; // somebody else got there first
    }
    // The lock is ours from the rename on, so a grave we cannot delete is litter
    // in HOME and nothing worse. Throwing here would deny the caller a lock it
    // has already won.
    try {
        rmSync(grave, { force: true });
    } catch { /* litter, under a name nothing else will ask for */ }
    return true;
};

// A lock file beside the data, created with 'wx' so the create either wins or
// fails. A holder killed mid-write would otherwise block the file forever, so a
// lock whose process is gone is taken from it.
export function withLock(file, work) {
    mkdirSync(HOME, { recursive: true });
    const lockFile = `${file}.lock`;
    if (heldHere.has(lockFile)) throw new Error(`agent-wire: withLock re-entered for ${lockFile}`);

    // What this acquisition writes into the lock, and the only thing the release
    // will delete. The pid comes first because holderIsGone reads it back.
    const stamp = `${process.pid} ${++acquisitions}-${Date.now().toString(36)}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    let held = null;
    while (held === null) {
        try {
            held = openSync(lockFile, 'wx');
        } catch (error) {
            // Windows answers EPERM, not EEXIST, when the target exists and another
            // process holds it open, and again while a delete is still pending. Both
            // mean the same thing here: somebody else has it, come back.
            if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
            // Losing the reclaim is not an error: it means another waiter took the
            // abandoned lock, so wait for that one the same as any other holder.
            if (holderIsGone(lockFile) && reclaim(lockFile, stamp)) continue;
            // Failing out loud beats writing over somebody else's change. A hook
            // that prints an error is a hook the user can do something about.
            if (Date.now() > deadline) {
                throw new Error(`agent-wire: ${lockFile} was held by another process for over ${LOCK_TIMEOUT_MS}ms`);
            }
            pause(LOCK_RETRY_MS);
        }
    }

    heldHere.add(lockFile);
    try {
        writeFileSync(held, stamp);
        return work();
    } finally {
        heldHere.delete(lockFile);
        // Releasing must not be able to fail work that already happened. A
        // markRead that rewrote states.json, or an appendMessages after the
        // message reached Slack, has to return what it did. Two separate
        // attempts, because sharing one would let a failed close skip the
        // delete, and the file left behind would hold this process's own pid.
        try {
            closeSync(held);
        } catch { /* the delete below is what actually matters */ }
        try {
            // Our own lock, and nobody else's. A holder declared gone while it
            // was still working deleted the file by path, and by then the file
            // was the lock of the process that had taken it, so a third one got
            // in while the second was still writing.
            if (readFileSync(lockFile, 'utf8') === stamp) rmSync(lockFile, { force: true });
        } catch { /* already gone, or unreadable; the reclaim path handles it */ }
    }
}

// Read fresh, change, write, all inside the lock. The read must not come from
// the cache: its stamp is mtimeMs:size, so two writes of the same size inside
// one millisecond would hand back the value this process already had.
export const updateJson = (file, fallback, mutate) => withLock(file, () => {
    const value = mutate(readJson(file, fallback));
    writeJson(file, value);
    return value;
});

export const loadConfig = () => readJson(paths.config, null);

export const saveConfig = (config) => writeJson(paths.config, config);

// Setup writes after every completed step, so the config IS the resume state and
// there is no second progress file to disagree with it.
export const patchConfig = (patch) => updateJson(paths.config, { version: 1 }, (config) => ({ ...config, ...patch }));

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
// Silent until asked. A channel nobody has opened in this session says nothing,
// because the alternative is every new window in every project announcing a
// channel the person opening it was not thinking about.
export function channelMode(config, channel, scope = scopeId()) {
    const chosen = config?.scopes?.[scope]?.[channel.name] ?? config?.scopes?.[projectScope()]?.[channel.name];
    if (MODES.includes(chosen)) return chosen;
    if (MODES.includes(channel.mode)) return channel.mode;

    // active: true was written before modes existed and said "on" out loud. Only
    // the absence of any answer means off.
    return channel.active === true ? 'ask' : 'off';
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
// Written under this session's id and nowhere else. A client keeps that id across
// a compact and a --resume, so the mode survives both; a NEW window is a new
// session and starts silent, which is the point of the default.
//
// 0.13.6 also wrote the folder entry here, so one session choosing read made every
// later session in that directory start on read. That is the surprise this
// reverts. A folder default is still settable, by running the command in a plain
// terminal, where the scope IS the folder.
export const setChannelMode = (name, mode) => withLock(paths.config, () => {
    const config = readJson(paths.config, null);
    if (!config) return null;

    const channel = findChannel(config, name);
    if (!channel) return null;

    const previous = channelMode(config, channel);
    const scopes = config.scopes ?? {};
    const mine = scopeId();

    // Deleted and reassigned rather than updated in place, so the key moves to
    // the end. prunedScopes drops session keys in insertion order, and a
    // long-lived session whose mode had just changed was going first.
    const chosen = { ...scopes[mine], [channel.name]: mode };
    delete scopes[mine];
    scopes[mine] = chosen;

    config.scopes = prunedScopes(scopes);
    writeJson(paths.config, config);
    return { channel, previous };
});

// One key per session id, and session ids are minted faster than they are ever
// reused. Folder entries are the ones worth keeping, so only session keys are
// dropped, oldest first.
const SCOPES_MAX = 60;
const SCOPES_KEEP = 40;

function prunedScopes(scopes) {
    const keys = Object.keys(scopes);
    if (keys.length <= SCOPES_MAX) return scopes;

    const folders = new Set([projectScope()]);
    for (const key of keys) if (key.includes(':') || key.includes('/')) folders.add(key);

    const sessions = keys.filter((key) => !folders.has(key));
    const doomed = new Set(sessions.slice(0, Math.max(0, keys.length - SCOPES_KEEP)));
    return Object.fromEntries(keys.filter((key) => !doomed.has(key)).map((key) => [key, scopes[key]]));
}

// Naming no channel is an answer only while there is one channel to mean. Past
// that it is a call that forgot the argument, and picking the first one sends
// somebody's work to the wrong room without a word.
export const isAmbiguous = (config, wanted) => !wanted && (config?.channels?.length ?? 0) > 1;

export function findChannel(config, wanted) {
    if (isAmbiguous(config, wanted)) return null;
    if (!wanted) return defaultChannel(config);
    const name = String(wanted).replace(/^#/, '').toLowerCase();
    return config.channels?.find((channel) => channel.name.toLowerCase() === name || channel.id === wanted) ?? null;
}
