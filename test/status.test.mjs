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

const { displayWidth, renderStatus } = await import('../src/status.mjs');
const { scopeId } = await import('../src/config.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('an emoji counts as the two columns a terminal draws', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('🔥'), 2);
    assert.equal(displayWidth('● on'), 4);
    assert.equal(displayWidth('🛰️'), 2); // pictographic plus a variation selector
});

test('every row of the panel is the same width, emoji or not', () => {
    const panel = renderStatus({
        nickname: 'grkn',
        mark: '🔥',
        public_key: 'MCowBQYDK2VwAyEAabcdefghijkl',
        team_id: 'T01ABCDEF',
        channels: [
            { id: 'C01', name: 'agent-wms' },
            { id: 'C02', name: 'agent-hcm', active: false },
        ],
    });

    const rows = panel.split('\n').filter(Boolean);
    const widths = new Set(rows.map(displayWidth));
    assert.equal(widths.size, 1, `rows are ragged: ${[...widths].join(', ')}`);
});

test('the panel opens with a blank line and marks each channel with its mode', () => {
    const panel = renderStatus({
        nickname: 'grkn',
        mark: '',
        public_key: 'k',
        channels: [{ name: 'loud' }, { name: 'live' }, { name: 'quiet', active: false }],
        scopes: { [scopeId()]: { loud: 'read' } },
    });

    assert.ok(panel.startsWith('\n'));
    assert.match(panel, /loud\s+● read/);
    assert.match(panel, /live\s+◐ ask/);
    assert.match(panel, /quiet\s+○ off/);
});

// A mode set in another session must not colour this session's panel.
test('the panel shows this session s mode, not another session s', () => {
    const config = {
        nickname: 'grkn',
        mark: '',
        public_key: 'k',
        channels: [{ name: 'live' }],
        scopes: { 'd:\\somewhere-else': { live: 'read' } },
    };

    assert.match(renderStatus(config), /live\s+◐ ask/);
});

test('the panel lists who has written, agents and humans alike', async () => {
    const { appendMessages } = await import('../src/inbox.mjs');
    appendMessages([
        { ts: '9.1', at: '2026-08-30T10:00:00Z', channel: 'live', from: 'mira', kind: 'agent', authorship: 'signed', text: 'x' },
        { ts: '9.2', at: '2026-08-31T10:00:00Z', channel: 'live', from: 'Zoë', kind: 'human', authorship: 'slack-verified', text: 'y' },
        { ts: '9.3', at: '2026-08-31T11:00:00Z', channel: 'live', from: 'grkn', kind: 'agent', authorship: 'self', text: 'mine' },
    ]);

    const panel = renderStatus({ nickname: 'grkn', mark: '🔥', public_key: 'k', channels: [{ name: 'live' }] });
    const rows = panel.split('\n').filter(Boolean);

    assert.match(panel, /\* mira/);
    assert.match(panel, /@ Zoë/);
    assert.doesNotMatch(panel, /\* grkn/, 'our own messages are not correspondents');
    assert.equal(new Set(rows.map(displayWidth)).size, 1, 'peer rows broke the alignment');
});

test('a name too wide for its column is cut to one marker character', () => {
    const panel = renderStatus({
        nickname: 'grkn',
        mark: '🔥',
        public_key: 'MCowBQYDK2VwAyEAabcdefghijklmnopqrstuvwxyz0123456789',
        channels: [{ name: 'agent-warehouse-management' }],
    });

    assert.match(panel, /agent-wareh…/);
    assert.equal(new Set(panel.split('\n').filter(Boolean).map(displayWidth)).size, 1);
});

test('a forged message stays on the record after a later valid one', async () => {
    const { appendMessages } = await import('../src/inbox.mjs');
    appendMessages([
        { ts: '8.1', at: '2026-08-29T10:00:00Z', channel: 'live', from: 'nox', kind: 'agent', authorship: 'impostor', text: 'forged' },
        { ts: '8.2', at: '2026-08-31T12:00:00Z', channel: 'live', from: 'nox', kind: 'agent', authorship: 'signed', text: 'later, valid' },
    ]);

    const panel = renderStatus({ nickname: 'grkn', mark: '', public_key: 'k', channels: [{ name: 'live' }] });

    assert.match(panel, /! nox/);
    assert.equal(new Set(panel.split('\n').filter(Boolean).map(displayWidth)).size, 1);
});

test('a config with no channels still renders a closed box', () => {
    const panel = renderStatus({ nickname: 'grkn', mark: '', public_key: 'k', channels: [] });

    assert.match(panel, /none configured/);
    assert.ok(panel.trimEnd().endsWith('┘'));
});

// A mode is a setting; the hook is what acts on it. The panel used to print
// "read, 5 unread" while nothing had delivered a word, which reads as working.
test('the panel says so when nothing is delivering', () => {
    const config = { nickname: 'grkn', mark: '🔥', team: 'Acme', public_key: 'MCowBQYDK2VwAyEA' + 'x'.repeat(30),
        channels: [{ id: 'C1', name: 'agent-wms' }] };

    writeFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, JSON.stringify({ hooks: {} }));
    assert.match(renderStatus(config), /nothing is delivering/);

    writeFileSync(process.env.AGENT_WIRE_CLIENT_SETTINGS, JSON.stringify(WITH_HOOK));
    assert.doesNotMatch(renderStatus(config), /nothing is delivering/);
});
