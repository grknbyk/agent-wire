import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;
// The hook lives in the client config, so point that at the sandbox too — a test
// must never reach into the real ~/.claude/settings.json.
process.env.AGENT_WIRE_CLIENT_SETTINGS = join(home, 'settings.json');

const { loadConfig, saveConfig } = await import('../src/config.mjs');
const { runDoctor, runSetup } = await import('../src/setup.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const calls = [];
globalThis.fetch = async (url) => {
    const method = String(url).split('/api/')[1];
    calls.push(method);
    const answers = {
        'auth.test': { ok: true, team: 'acmeco', team_id: 'T1', user_id: 'U_ME', user: 'mira.k' },
        // The private one first: it is the one the old types filter hid.
        'users.conversations': { ok: true, channels: [{ id: 'C_PRIV', name: 'dev-agents' }, { id: 'C_PUB', name: 'wire-agents' }] },
        'chat.postMessage': { ok: true, ts: '1788254483.341549' },
    };
    if (!answers[method]) throw new Error(`no stub for ${method}`);
    return { status: 200, ok: true, json: async () => answers[method] };
};

// readline drains a piped stdin in one gulp, so the answers arrive one per tick
// instead, which is what a person typing looks like.
function types(answers) {
    const keyboard = new PassThrough();
    keyboard.isTTY = true;
    Object.defineProperty(process, 'stdin', { value: keyboard, configurable: true });

    let typed = 0;
    const timer = setInterval(() => {
        if (typed < answers.length) keyboard.write(`${answers[typed++]}\n`);
        else { keyboard.end(); clearInterval(timer); }
    }, 20);
    return () => clearInterval(timer);
}

const quietly = async (run) => {
    const speak = console.log;
    console.log = () => {};
    try { return await run(); } finally { console.log = speak; }
};

// No browser and no real clients in a test: the login answers at once, Claude Code is
// present but unregistered, pi is absent.
const connect = async ({ clientId }) => ({
    ok: true,
    user: 'mira.k',
    saved: { client_id: clientId, user_token: 'xoxp-fake', user_id: 'U_ME', team: 'acmeco', team_id: 'T1' },
});
const registered = [];
const clients = {
    claudeState: async () => (registered.length ? 'installed' : 'absent'),
    installClaude: async () => { registered.push('agent-wire'); return { ok: true }; },
    piState: () => 'missing',
    installPi: () => { throw new Error('pi is not here'); },
};
const doctor = () => runDoctor({ clients });

// The first question decides whether the steps are shown; a token is never taken for the Client ID.
test('a team with no Slack app yet is sent to create one, and a pasted token is refused', async () => {
    const { createAppUrl } = await import('../src/setup.mjs');
    const opened = [];
    const stop = types(['n', 'xoxb-1-2-abc', '']);
    const exit = await quietly(() => runSetup({ connect, clients, open: (url) => opened.push(url) }));
    stop();

    assert.equal(exit, 1, 'no Client ID, so setup stops and can be run again');
    assert.equal(loadConfig(), null, 'nothing is saved, least of all the token');
    assert.deepEqual(opened, [createAppUrl()]);
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'manifest.json'), 'utf8'));
    assert.deepEqual(JSON.parse(new URL(opened[0]).searchParams.get('manifest_json')), manifest);
    // The guide carries the same link, so a changed manifest cannot leave an old one behind.
    assert.ok(readFileSync(join(import.meta.dirname, '..', 'docs', 'slack-app.md'), 'utf8').includes(createAppUrl()));
});

// The person picks the channels from the ones they are in; nothing is adopted unasked.
test('setup logs in, takes the chosen channels, and plugs into Claude Code', async () => {
    const stop = types(['y', 'C123.456', '2', 'mira', 'y']);
    const exit = await quietly(() => runSetup({ connect, clients }));
    stop();

    assert.equal(exit, 0);
    const config = loadConfig();
    assert.deepEqual(config.channels, [{ id: 'C_PUB', name: 'wire-agents' }]);
    assert.deepEqual(config.channel_lists, { allow: ['wire-agents'], ask: [], deny: [] });
    assert.equal(config.user_token, 'xoxp-fake');
    assert.equal(config.client_id, 'C123.456');
    assert.equal(config.bot_token, undefined, 'there is no bot');
    assert.equal(calls.filter((method) => method === 'chat.postMessage').length, 1, 'hello only in the chosen channel');
    assert.deepEqual(registered, ['agent-wire']);
});

// "The lists are the person's": a later run must not undo a placement, nor leave a channel the
// person has just picked on no list, where posting to it is refused without a word at setup.
test('a channel picked on a later run may be posted in; one the person placed stays placed', async () => {
    const before = loadConfig();
    saveConfig({ ...before, channel_lists: { allow: [], ask: ['wire-agents'], deny: [] } });
    const stop = types(['1,2', '']);
    const exit = await quietly(() => runSetup({ connect, clients }));
    stop();

    assert.equal(exit, 0);
    assert.deepEqual(loadConfig().channel_lists, { allow: ['dev-agents'], ask: ['wire-agents'], deny: [] });
    saveConfig(before);
});

test('channel numbers are read strictly', async () => {
    const { pickChannels } = await import('../src/setup.mjs');
    const joined = [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }];
    assert.deepEqual(pickChannels('2, 1 2', joined).map((c) => c.id), ['B', 'A']);
    assert.equal(pickChannels('3', joined), null);
    assert.equal(pickChannels('x', joined), null);
    assert.equal(pickChannels('', joined), null);
});

test('doctor reports the account and every chosen channel', async () => {
    assert.equal(await quietly(doctor), 0);
});

// Setup writes the login before it asks for a name, and invites you to quit
// halfway. Doctor threw a TypeError on that config instead of naming the step.
test('doctor names the missing step when setup was quit halfway', async () => {
    const finished = loadConfig();
    saveConfig({ version: 1, user_token: 'xoxp-fake', team: 'acmeco' });
    assert.equal(await quietly(doctor), 1);

    saveConfig({ version: 1, team: 'acmeco' });
    assert.equal(await quietly(doctor), 1, 'no login at all');
    saveConfig(finished);
});

// The modes were a setting with nothing behind them: `read` delivered through a
// prompt hook that nothing installed, audited, or admitted was missing.
test('setup installs the prompt hook that read and ask are delivered by', async () => {
    const { hookState } = await import('../src/hook.mjs');
    const written = JSON.parse(readFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, 'utf8'));

    assert.equal(hookState(), 'installed');
    // node and the script by name, not `agent-wire drain`: the npm shim in front of
    // that spelling cost 187 ms of every turn and did nothing else.
    const [entry] = written.hooks.UserPromptSubmit;
    assert.match(entry.hooks[0].command, /agent-wire\.mjs" drain$/);
    assert.match(entry.hooks[0].command, /node/i);
});

test('a hook naming a file that is gone is broken, not installed', async () => {
    // The price of skipping the shim is an absolute path, and a path can stop being
    // true. A hook that fails silently is a channel that goes quiet without saying
    // why, so the state has a name and `doctor` fails on it.
    const { hookState } = await import('../src/hook.mjs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const installed = readFileSync(settings, 'utf8');

    writeFileSync(settings, JSON.stringify({
        hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"node" "/gone/bin/agent-wire.mjs" drain' }] }],
        },
    }));
    assert.equal(hookState(), 'broken');
    assert.equal(await quietly(doctor), 1);

    writeFileSync(settings, installed);
    assert.equal(hookState(), 'installed');
});

test('the legacy shim command still counts as installed', async () => {
    // Someone upgrading has `agent-wire drain` in their settings. It names no script,
    // so there is no path to check and nothing to call broken — it works, it is just
    // slower, and telling them it is broken would be a lie.
    const { hookState } = await import('../src/hook.mjs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const installed = readFileSync(settings, 'utf8');

    writeFileSync(settings, JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'agent-wire drain' }] }] },
    }));
    assert.equal(hookState(), 'installed');

    writeFileSync(settings, installed);
});

test('installing twice leaves one drain hook, and never touches anyone else\'s', async () => {
    // Appending blindly is how a machine ends up draining twice per prompt, the
    // second call delivering nothing because the first marked everything read.
    const { hookState, installHook } = await import('../src/hook.mjs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const installed = readFileSync(settings, 'utf8');

    writeFileSync(settings, JSON.stringify({
        hooks: {
            UserPromptSubmit: [
                { hooks: [{ type: 'command', command: 'agent-wire drain' }] },
                { hooks: [{ type: 'command', command: 'somebody-elses-tool --watch' }] },
            ],
        },
    }));
    installHook();
    installHook();

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    const commands = written.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks).map((hook) => hook.command);
    assert.equal(commands.filter((command) => command.includes('drain')).length, 1, 'drain must be installed once');
    assert.ok(commands.includes('somebody-elses-tool --watch'), 'another tool\'s hook was dropped');
    assert.equal(hookState(), 'installed');

    writeFileSync(settings, installed);
});

test('doctor fails, rather than reassures, when nothing delivers', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const installed = readFileSync(settings, 'utf8');

    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    assert.equal(await quietly(doctor), 1);

    writeFileSync(settings, installed);
    assert.equal(await quietly(doctor), 0);
});

test('the pi extension goes in, and the agent-wire entry leaves pi mcp.json with a copy kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-wire-pi-'));
    process.env.AGENT_WIRE_PI_DIR = dir;
    try {
        const { installPi, piExtension, piState } = await import('../src/clients.mjs');
        const mcp = { mcpServers: { other: { command: 'x' }, 'agent-wire': { command: 'agent-wire', args: ['serve'] } } };
        writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcp));
        assert.equal(piState(), 'absent');

        const done = installPi();
        assert.equal(piState(), 'installed');
        assert.ok(readFileSync(piExtension(), 'utf8').includes('registerMcpServer'));
        assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers), ['other']);
        assert.ok(done.removedEntry && readFileSync(done.backup, 'utf8').includes('agent-wire'));

        writeFileSync(piExtension(), '// an older copy');
        assert.equal(piState(), 'stale');
    } finally {
        delete process.env.AGENT_WIRE_PI_DIR;
        rmSync(dir, { recursive: true, force: true });
    }
});

// What a run printed, line by line.
const said = async (run) => {
    const lines = [];
    const speak = console.log;
    console.log = (line = '') => { lines.push(String(line)); };
    try { await run(); } finally { console.log = speak; }
    return lines;
};

test('doctor does not call a version the newest when the registry did not answer', async () => {
    // The stub above has no answer for the npm registry: a check that gets none.
    const version = (await said(doctor)).find((line) => line.startsWith('version'));
    assert.match(version, /did not answer/);
    assert.doesNotMatch(version, /newest published/);
});

test('doctor calls the version the newest only when the registry said so', async () => {
    const { installedVersion } = await import('../src/version.mjs');
    const stubbed = globalThis.fetch;
    globalThis.fetch = async (url, init) => (String(url).includes('registry.npmjs.org')
        ? { ok: true, json: async () => ({ version: installedVersion() }) }
        : stubbed(url, init));
    try {
        const version = (await said(doctor)).find((line) => line.startsWith('version'));
        assert.match(version, /the newest published/);
    } finally {
        globalThis.fetch = stubbed;
    }
});

test('the backup keeps the settings as they were before agent-wire, however often the hook goes in', async () => {
    const { installHook } = await import('../src/hook.mjs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const backup = `${settings}.agent-wire.bak`;
    const installed = readFileSync(settings, 'utf8');
    rmSync(backup, { force: true });

    const original = JSON.stringify({ theme: 'dark' });
    writeFileSync(settings, original);
    assert.equal(installHook().backedUp, true);
    assert.equal(readFileSync(backup, 'utf8'), original);

    assert.equal(installHook().backedUp, false, 'the copy already there is the one worth keeping');
    assert.equal(readFileSync(backup, 'utf8'), original, 'a copy of a file that already holds our hook did not replace it');

    writeFileSync(settings, installed);
    rmSync(backup, { force: true });
});
