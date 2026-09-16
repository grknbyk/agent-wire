// Modes were a setting with nothing behind them. `read` and `ask` are delivered by
// a client hook that runs `agent-wire drain` before every prompt, and nothing in
// the package installed one, audited one, or admitted it was missing — so a channel
// could sit on `read` with five unread and never say a word.
//
// The MCP server cannot do this job. A tool runs when the agent calls it, and the
// point of `read` is that nobody has to ask.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT = 'UserPromptSubmit';

// `agent-wire drain` reached the CLI through the npm shim, and the shim is not
// free: 318 ms per turn measured against 131 ms for the same work called
// directly, so 187 ms of wrapper was being paid on every single prompt. Naming
// node and the script skips it. The price is an absolute path that a change of
// npm prefix can invalidate, which is what `broken` below exists to catch — a
// hook that fails is a channel that goes quiet without saying why.
const cliPath = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wire.mjs');

export const hookCommand = () => `"${process.execPath}" "${cliPath()}" drain`;

// Quoted or bare, the script is the one token ending in agent-wire.mjs. The
// legacy shim command names no script, and that form still works.
const scriptIn = (command) => command.match(/[^"'\s]*agent-wire\.mjs/)?.[0] ?? null;

const isOurs = (hook) => {
    const command = String(hook.command ?? '');
    return command.includes('agent-wire') && command.includes('drain');
};

const drainCommands = (settings) => (settings.hooks?.[EVENT] ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .filter(isOurs)
    .map((hook) => String(hook.command ?? ''));

// Overridable so a test never reaches for the real one. Nothing else sets it.
export const settingsPath = () =>
    process.env.AGENT_WIRE_CLIENT_SETTINGS || join(homedir(), '.claude', 'settings.json');

const readSettings = (path) => {
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined; // present but unparseable, which is not ours to repair
    }
};

// 'installed' | 'broken' | 'missing' | 'unreadable' | 'no-client'
export function hookState(path = settingsPath()) {
    const settings = readSettings(path);
    if (settings === null) return 'no-client';
    if (settings === undefined) return 'unreadable';

    const commands = drainCommands(settings);
    if (commands.length === 0) return 'missing';

    // One surviving command still delivers, so the state is broken only when
    // every one of them points at a file that is not there any more.
    const working = commands.filter((command) => {
        const script = scriptIn(command);
        return !script || existsSync(script);
    });
    return working.length > 0 ? 'installed' : 'broken';
}

export const hookSnippet = () => JSON.stringify(
    { hooks: { [EVENT]: [{ hooks: [{ type: 'command', command: hookCommand() }] }] } },
    null,
    2,
);

// Writes through a temp file and keeps a .bak, because this is the user's own
// client config and every other key in it belongs to somebody else.
export function installHook(path = settingsPath()) {
    const settings = readSettings(path);
    if (settings === undefined) return { ok: false, reason: `${path} is not valid JSON — add the hook by hand` };

    const merged = settings ?? {};
    const hooks = merged.hooks ?? {};

    // Ours come out before ours goes in. Appending blindly is how a machine ends
    // up running drain twice per prompt: once through the old shim command and
    // once through the new one, the second delivering nothing because the first
    // already marked everything read.
    const theirs = (hooks[EVENT] ?? [])
        .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !isOurs(hook)) }))
        .filter((entry) => entry.hooks.length > 0);
    hooks[EVENT] = [...theirs, { hooks: [{ type: 'command', command: hookCommand() }] }];
    merged.hooks = hooks;

    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) writeFileSync(`${path}.agent-wire.bak`, readFileSync(path));

    const tempFile = `${path}.${process.pid}.tmp`;
    writeFileSync(tempFile, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(tempFile, path);
    return { ok: true, path, backedUp: settings !== null };
}
