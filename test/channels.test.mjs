import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { activeChannels, saveConfig, setChannelActive } = await import('../src/config.mjs');
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

test('a channel with no active flag counts as on', () => {
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

test('switching a channel off and on again is recorded in the config', () => {
    assert.equal(setChannelActive('agent-wms', false).active, false);
    assert.deepEqual(activeChannels({ channels: [{ name: 'x', active: false }] }), []);

    assert.equal(setChannelActive('#agent-wms', true).active, true);
    assert.equal(setChannelActive('no-such-channel', false), null);
});
