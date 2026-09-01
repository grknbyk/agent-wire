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

const EVENT = 'UserPromptSubmit';
export const HOOK_COMMAND = 'agent-wire drain';

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

// 'installed' | 'missing' | 'unreadable' | 'no-client'
export function hookState(path = settingsPath()) {
    const settings = readSettings(path);
    if (settings === null) return 'no-client';
    if (settings === undefined) return 'unreadable';

    const entries = settings.hooks?.[EVENT] ?? [];
    const commands = entries.flatMap((entry) => entry.hooks ?? []).map((hook) => String(hook.command ?? ''));
    return commands.some((command) => command.includes('agent-wire') && command.includes('drain')) ? 'installed' : 'missing';
}

export const hookSnippet = () => JSON.stringify(
    { hooks: { [EVENT]: [{ hooks: [{ type: 'command', command: HOOK_COMMAND }] }] } },
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
    hooks[EVENT] = [...(hooks[EVENT] ?? []), { hooks: [{ type: 'command', command: HOOK_COMMAND }] }];
    merged.hooks = hooks;

    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) writeFileSync(`${path}.agent-wire.bak`, readFileSync(path));

    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`);
    renameSync(temporary, path);
    return { ok: true, path, backedUp: settings !== null };
}
