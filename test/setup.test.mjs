import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
        'auth.test': { ok: true, team: 'ceomed', team_id: 'T1', user_id: 'U_BOT' },
        // The private one first: it is the one the old types filter hid.
        'users.conversations': { ok: true, channels: [{ id: 'C_PRIV', name: 'wms-agents' }, { id: 'C_PUB', name: 'wire-agents' }] },
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

// Setup used to ask for a channel by name, and got told the bot was in no channel
// by that name whenever the team had made theirs private.
test('setup adopts every channel the bot is in, private ones included', async () => {
    const stop = types(['xoxb-fake-token', 'mira', ':peach:', 'y']);
    const exit = await quietly(runSetup);
    stop();

    assert.equal(exit, 0);
    assert.deepEqual(loadConfig().channels, [
        { id: 'C_PRIV', name: 'wms-agents' },
        { id: 'C_PUB', name: 'wire-agents' },
    ]);
    assert.equal(calls.filter((method) => method === 'chat.postMessage').length, 2);
});

test('doctor reports every adopted channel', async () => {
    assert.equal(await quietly(runDoctor), 0);
});

// Setup writes the token before it asks for a name, and invites you to quit
// halfway. Doctor threw a TypeError on that config instead of naming the step.
test('doctor names the missing step when setup was quit halfway', async () => {
    const finished = loadConfig();
    saveConfig({ version: 1, bot_token: 'xoxb-fake-token', team: 'ceomed' });

    assert.equal(await quietly(runDoctor), 1);
    saveConfig(finished);
});

// The modes were a setting with nothing behind them: `read` delivered through a
// prompt hook that nothing installed, audited, or admitted was missing.
test('setup installs the prompt hook that read and ask are delivered by', async () => {
    const { hookState } = await import('../src/hook.mjs');
    const written = JSON.parse((await import('node:fs')).readFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, 'utf8'));

    assert.equal(hookState(), 'installed');
    assert.match(JSON.stringify(written.hooks.UserPromptSubmit), /agent-wire drain/);
});

test('doctor fails, rather than reassures, when nothing delivers', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    const settings = process.env.AGENT_WIRE_CLIENT_SETTINGS;
    const installed = readFileSync(settings, 'utf8');

    writeFileSync(settings, JSON.stringify({ hooks: {} }));
    assert.equal(await quietly(runDoctor), 1);

    writeFileSync(settings, installed);
    assert.equal(await quietly(runDoctor), 0);
});
