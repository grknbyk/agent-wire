import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { displayWidth, renderStatus } = await import('../src/status.mjs');

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

test('the panel opens with a blank line and marks channels on and off', () => {
    const panel = renderStatus({
        nickname: 'grkn',
        mark: '',
        public_key: 'k',
        channels: [{ name: 'live' }, { name: 'quiet', active: false }],
    });

    assert.ok(panel.startsWith('\n'));
    assert.match(panel, /live\s+● on/);
    assert.match(panel, /quiet\s+○ off/);
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
