// The clients agent-wire plugs into, besides the prompt hook (hook.mjs): Claude Code takes the
// MCP server through its own CLI, pi takes an extension that registers the server and does the
// hook's job. Setup offers each one it finds on this machine; doctor reports them.
import { exec } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PI_SOURCE = join(PACKAGE_ROOT, 'integrations', 'pi', 'agent-wire.ts');
const CLI = join(PACKAGE_ROOT, 'bin', 'agent-wire.mjs');

export const piDir = () => process.env.AGENT_WIRE_PI_DIR || join(homedir(), '.pi', 'agent');
export const piExtension = () => join(piDir(), 'extensions', 'agent-wire.ts');
const piMcpConfig = () => join(piDir(), 'mcp.json');

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

// missing (no pi here), absent (pi, no extension), stale (an older copy), installed.
export function piState() {
    if (!existsSync(piDir())) return 'missing';
    const installed = readText(piExtension());
    if (installed === null) return 'absent';
    return installed === readText(PI_SOURCE) ? 'installed' : 'stale';
}

// The extension registers the MCP server itself, with this session's scope. An agent-wire entry
// in pi's mcp.json would win over it, so it is taken out, after a copy into pi's backups folder.
export function installPi() {
    mkdirSync(dirname(piExtension()), { recursive: true });
    copyFileSync(PI_SOURCE, piExtension());

    const mcpPath = piMcpConfig();
    const raw = readText(mcpPath);
    if (raw === null) return { ok: true, removedEntry: false };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { ok: true, removedEntry: false, note: 'mcp.json is not valid JSON; left as it is' }; }
    const servers = parsed.mcpServers ?? {};
    if (!servers['agent-wire']) return { ok: true, removedEntry: false };

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
    const backup = join(piDir(), 'backups', `mcp.json.${stamp}-agent-wire.bak`);
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, raw);
    delete servers['agent-wire'];
    writeFileSync(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return { ok: true, removedEntry: true, backup };
}

// The full path of a command, from PATH's absolute folders only. Given a bare name, cmd.exe (and
// libuv's own search on Windows) looks in the current folder first, so a repo holding claude.cmd
// would run in place of Claude Code (security scan, 05.11). Null: not on PATH.
export function onPath(name, env = process.env, platform = process.platform) {
    const extensions = platform === 'win32' ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const folder of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
        if (!folder || !isAbsolute(folder)) continue;
        for (const extension of extensions) {
            const file = join(folder, `${name}${extension.toLowerCase()}`);
            if (existsSync(file)) return file;
        }
    }
    return null;
}

// Claude Code keeps MCP servers in its own config, which its CLI edits. One fixed command line,
// nothing from outside in it: on Windows `claude` may be a .cmd that only a shell runs, and a
// shell given separate arguments joins them unescaped (Node warns, DEP0190). The command goes by
// its full path, quoted. Null: no claude here.
const claude = (args) => new Promise((resolve) => {
    const command = onPath('claude');
    if (!command) return resolve(null);
    exec(`"${command}" ${args.join(' ')}`, { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) =>
        resolve(error && (error.code === 127 || error.code === 'ENOENT') ? null : { ok: !error, out: `${stdout}${stderr}`.trim() }));
});

// The server Claude Code starts: this node and this install by full path, as the prompt hook
// does (hook.mjs), so no bare `agent-wire` is looked up in whatever folder Claude Code runs in.
export const serverCommand = () => ['--', `"${process.execPath}"`, `"${CLI}"`, 'serve'];

// missing (no claude CLI), absent (not registered), installed.
export async function claudeState() {
    const answer = await claude(['mcp', 'get', 'agent-wire']);
    if (answer === null || /not recognized|command not found/i.test(answer.out)) return 'missing';
    return answer.ok ? 'installed' : 'absent';
}

export async function installClaude() {
    const answer = await claude(['mcp', 'add', '-s', 'user', 'agent-wire', ...serverCommand()]);
    if (answer === null) return { ok: false, reason: 'no claude command on this machine' };
    return answer.ok ? { ok: true } : { ok: false, reason: answer.out.split('\n')[0] };
}
