import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

// The panel warns when nothing is delivering, so these tests hand it a client
// that already has the hook. The warning has a test of its own below.
process.env.AGENT_WIRE_CLIENT_SETTINGS = join(home, 'settings.json');
const WITH_HOOK = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'agent-wire drain' }] }] } };
writeFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, JSON.stringify(WITH_HOOK));

const { renderStatus } = await import('../src/status.mjs');
const { scopeId } = await import('../src/config.mjs');


test.after(() => rmSync(home, { recursive: true, force: true }));

const base = {
    nickname: 'juno',
    channels: [{ id: 'C1', name: 'dev-agents' }, { id: 'C2', name: 'atlas-agents' }],
    channel_lists: { allow: ['dev-agents'], ask: [], deny: [] },
    dm: { allow: ['ellis'], ask: [], deny: ['ahmet'] },
};

test('the status shows only the open rows, and says everything else is denied', () => {
    const lines = renderStatus(base, { slack: { user: 'mira.kowalski1' } }).split('\n');
    assert.match(lines[0], /^Slack: mira\.kowalski1 · version \d+\.\d+\.\d+$/);
    assert.deepEqual(lines.slice(1), [
        '',
        'Read   Write  Channel',
        'deny   allow  dev-agents',
        '',
        'Read   Write  User',
        'allow  allow  ellis',
        '',
        'Everything else is denied.',
    ]);
    assert.doesNotMatch(lines.join('\n'), /ahmet|atlas-agents/, 'a closed row is not listed by name');
});

test('a row shows the name Slack gives, the channel\'s read mode and a person\'s own read list', () => {
    const config = { ...base, channels: [{ id: 'C1', name: 'dev-agents', mode: 'read' }], dm_read: { allow: [], ask: ['juno.park'], deny: ['ellis'] } };
    const labels = { channels: new Map([['dev-agents', 'dev-agents (private)']]), people: new Map([['ellis', 'Ellis Hart (ellis)']]) };
    const shown = renderStatus(config, { slack: { user: 'x' }, labels });
    assert.deepEqual(shown.split('\n').slice(2), [
        'Read   Write  Channel',
        'allow  allow  dev-agents (private)',
        '',
        'Read   Write  User',
        'deny   allow  Ellis Hart (ellis)',
        'ask    deny   juno.park',
        '',
        'Everything else is denied.',
    ]);
    assert.doesNotMatch(shown, /\x1b/, 'plain unless colour is asked for: an agent reads this text');
    assert.match(renderStatus(config, { slack: { user: 'x' }, labels, color: true }), /\x1b\[38;5;108mallow/);
    assert.match(renderStatus({ nickname: 'juno' }, { slack: { user: 'x' } }), /Read {3}Write {2}Channel\n-\n\nRead {3}Write {2}User\n-\n/);
});

test('no answer from Slack says so and how to fix it', () => {
    assert.match(renderStatus(base, { slack: { error: 'invalid_auth' } }), /^Slack: not connected \(invalid_auth\) — run `agent-wire login`/);
});

// A mode is a setting; the hook is what acts on it.
test('the status says so when nothing is delivering', () => {
    const config = { ...base, scopes: { [scopeId()]: { 'dev-agents': 'ask' } } };
    writeFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, JSON.stringify({ hooks: {} }));
    assert.match(renderStatus(config), /nothing is delivering/);
    writeFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, JSON.stringify(WITH_HOOK));
    assert.doesNotMatch(renderStatus(config), /nothing is delivering/);
});
