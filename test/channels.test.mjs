import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { activeChannels, channelMode, loadConfig, pollableChannels, projectScope, saveConfig, scopeId, setChannelMode } =
    await import('../src/config.mjs');
const { appendMessages, selectMessages } = await import('../src/inbox.mjs');

const message = (channel, ts) => ({ ts, at: '2026-08-31T00:00:00Z', channel, from: 'mira', kind: 'agent', authorship: 'signed', text: `from ${channel}` });

test.before(() => {
    saveConfig({
        version: 1,
        nickname: 'grkn',
        channels: [
            { id: 'C01', name: 'agent-wms' },
            { id: 'C02', name: 'agent-crm', active: true },
            { id: 'C03', name: 'agent-hcm', active: false },
        ],
    });
    appendMessages([message('agent-wms', '1.1'), message('agent-crm', '2.1'), message('agent-hcm', '3.1')]);
});

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a channel written before modes existed keeps its old on and off', () => {
    const names = activeChannels({ channels: [{ name: 'a' }, { name: 'b', active: true }, { name: 'c', active: false }] })
        .map((channel) => channel.name);

    assert.deepEqual(names, ['a', 'b']);
});

test('the default view skips channels that are switched off', () => {
    const allowed = activeChannels({
        channels: [{ name: 'agent-wms' }, { name: 'agent-crm', active: true }, { name: 'agent-hcm', active: false }],
    }).map((channel) => channel.name);
    const seen = selectMessages({ state: 'all', channels: allowed }).map((item) => item.channel);

    assert.deepEqual(seen.sort(), ['agent-crm', 'agent-wms']);
});

test('naming a switched-off channel still reads its history', () => {
    const seen = selectMessages({ state: 'all', channel: 'agent-hcm' }).map((item) => item.channel);

    assert.deepEqual(seen, ['agent-hcm']);
});

test('a mode is recorded against this session, not against the channel', () => {
    assert.notEqual(setChannelMode('agent-wms', 'read'), null);

    const config = loadConfig();
    assert.equal(config.scopes[scopeId()]['agent-wms'], 'read');
    assert.equal(config.channels[0].mode, undefined);
    assert.equal(channelMode(config, config.channels[0]), 'read');

    assert.notEqual(setChannelMode('#agent-wms', 'ask'), null);
    assert.equal(channelMode(loadConfig(), loadConfig().channels[0]), 'ask');
    assert.equal(setChannelMode('no-such-channel', 'off'), null);
});

test('another session keeps its own mode for the same channel', () => {
    setChannelMode('agent-wms', 'off');

    const config = loadConfig();
    const wms = config.channels[0];
    config.scopes['d:\\other'] = { 'agent-wms': 'read' };

    assert.equal(channelMode(config, wms), 'off');
    assert.equal(channelMode(config, wms, 'd:\\other'), 'read');
    assert.equal(channelMode(config, wms, 'd:\\never-set'), 'ask');
});

// One poller feeds every session, so the quietest session must not decide what
// the busiest one is allowed to see.
test('a channel one session switched off is still polled for the others', () => {
    const config = {
        channels: [{ name: 'agent-wms' }, { name: 'agent-crm' }],
        scopes: {
            'c:\\quiet': { 'agent-wms': 'off', 'agent-crm': 'off' },
            'c:\\busy': { 'agent-wms': 'read' },
        },
    };

    assert.deepEqual(pollableChannels(config).map((channel) => channel.name), ['agent-wms']);
});

// A team that keeps its agent channel private was told the bot was in no channel
// by that name, while chat:write posted into it happily. The types filter asked
// for public channels only, so the invite it already had was invisible.
test('a private channel the bot was invited to is discovered like any other', async () => {
    const asked = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        asked.push(new URLSearchParams(options.body).get('types'));
        return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, channels: [{ id: 'C0BQ', name: 'wms-agents', is_private: true }] }),
        };
    };

    const { joinedChannels, slackClient } = await import('../src/slack.mjs');
    const found = await joinedChannels(slackClient('xoxb-test'));
    globalThis.fetch = realFetch;

    assert.deepEqual(found, { ok: true, channels: [{ id: 'C0BQ', name: 'wms-agents' }] });
    assert.deepEqual(asked, ['public_channel,private_channel']);
});

// Two windows open on one project used to share a mode, because the working
// directory was the only thing a freshly launched drain could see. The client
// publishes a session id now, and the directory entry is what a session that has
// chosen nothing falls back to — which is how a project default still exists.
test('a session with its own choice overrides the project default', () => {
    const channel = { name: 'agent-wms' };
    const config = {
        channels: [channel],
        scopes: {
            [projectScope()]: { 'agent-wms': 'ask' },
            'session-a': { 'agent-wms': 'read' },
        },
    };

    assert.equal(channelMode(config, channel, 'session-a'), 'read');
    assert.equal(channelMode(config, channel, 'session-b'), 'ask');
});

test('with no project entry either, a channel is on ask', () => {
    const channel = { name: 'agent-wms' };
    assert.equal(channelMode({ channels: [channel], scopes: {} }, channel, 'session-a'), 'ask');
});

// scopeId is resolved once per process, so the choice of source is checked in a
// child rather than by reassigning env in this one.
test('the client session id is preferred over the working directory', async () => {
    const { execFileSync } = await import('node:child_process');
    const read = (env) => execFileSync(process.execPath, ['-e', 'import("./src/config.mjs").then((m) => console.log(m.scopeId()))'],
        { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

    assert.equal(read({ CLAUDE_CODE_SESSION_ID: 'UUID-1', AGENT_WIRE_SCOPE: '' }), 'uuid-1');
    assert.equal(read({ CLAUDE_CODE_SESSION_ID: 'UUID-1', AGENT_WIRE_SCOPE: 'forced' }), 'forced');
    assert.equal(read({ CLAUDE_CODE_SESSION_ID: '', AGENT_WIRE_SCOPE: '' }), process.cwd().toLowerCase());
});
