import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { loadConfig, pollableChannels, saveConfig } = await import('../src/config.mjs');
const { dmReadVerdict } = await import('../src/policy.mjs');
const { applyChange, loadScreen, openScreen, press, render, runScreen, saveChange, visible } = await import('../src/tui.mjs');

const config = {
    version: 1,
    user_id: 'U00',
    channels: [{ id: 'C01', name: 'dev-agents' }],
    channel_lists: { allow: ['dev-agents'], ask: [], deny: [] },
    dm: { allow: ['ellis'], ask: [], deny: ['gone.person'] },
};
const channels = [
    { id: 'C02', name: 'release-notes', private: true },
    { id: 'C01', name: 'dev-agents', private: false },
];
const people = [
    { id: 'U00', handle: 'me', name: 'Me' },
    { id: 'U02', handle: 'gokce.y', name: 'Gökçe Yıldırım' },
    { id: 'U01', handle: 'ellis', name: 'Ellis Hart' },
];
const keys = (state, ...names) => names.reduce((now, name) => press(now, name.length === 1 ? { sequence: name } : { name }), state);
const shownAs = (item) => `${item.read} ${item.write} ${item.label}`;

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a row holds read and write beside "name (username)" or "channel (public|private)", open ones first, without the user', () => {
    const state = openScreen({ config, channels, people });
    assert.deepEqual(state.rows.channels.map(shownAs), ['deny allow dev-agents (public)', 'deny deny release-notes (private)']);
    assert.deepEqual(state.rows.dm.map(shownAs), ['allow allow Ellis Hart (ellis)', 'deny deny Gökçe Yıldırım (gokce.y)']);
});

test('read comes from the channel\'s own mode and from the person\'s read list', () => {
    const set = { ...config, channels: [{ id: 'C01', name: 'dev-agents', mode: 'read' }], dm_read: { allow: [], ask: ['gokce.y'], deny: ['ellis'] } };
    const state = openScreen({ config: set, channels, people });
    assert.equal(state.rows.channels[0].read, 'allow');
    assert.deepEqual(state.rows.dm.map(shownAs), ['deny allow Ellis Hart (ellis)', 'ask deny Gökçe Yıldırım (gokce.y)']);
});

test('the search finds a Turkish name typed without its marks, in the name or the username', () => {
    const dm = press(openScreen({ config, channels, people }), { name: 'tab' });
    assert.deepEqual(visible(keys(dm, ...'gokce yildirim')).map((item) => item.key), ['gokce.y']);
    assert.deepEqual(visible(keys(dm, ...'ELLIS')).map((item) => item.key), ['ellis']);
    assert.equal(visible(keys(dm, ...'nobody')).length, 0);
});

test('enter takes the cell under the cursor from deny to allow to ask and back; left and right pick the cell', () => {
    const start = openScreen({ config, channels, people });
    assert.equal(keys(start, 'return').rows.channels[0].read, 'allow');
    assert.equal(keys(start, 'return', 'return').rows.channels[0].read, 'ask');
    assert.equal(keys(start, 'return', 'return', 'return').rows.channels[0].read, 'deny');
    assert.equal(keys(start, 'right', 'return').rows.channels[0].write, 'ask');
    assert.equal(keys(start, 'right', 'left', 'return').rows.channels[0].write, 'allow');
    assert.deepEqual(keys(start, 'return').change, { tab: 'channels', side: 'read', value: 'allow', key: 'dev-agents', source: channels[1] });
    assert.equal(keys(start, 'return', 'down').change, null, 'a change is handed over once');
});

test('escape clears a search first and closes second; enter never closes', () => {
    const searching = keys(openScreen({ config, channels, people }), 'r', 'e');
    assert.equal(press(searching, { name: 'escape' }).done, false);
    assert.equal(press(press(searching, { name: 'escape' }), { name: 'escape' }).done, true);
    assert.equal(press(searching, { name: 'return' }).done, false);
    assert.equal(press(searching, { name: 'c', ctrl: true, sequence: '\x03' }).done, true);
});

test('opening a channel setup never picked adds it, without letting it post', () => {
    const reading = { tab: 'channels', side: 'read', value: 'allow', key: 'release-notes', source: channels[0] };
    const saved = applyChange(config, reading);
    assert.deepEqual(saved.channels, [{ id: 'C01', name: 'dev-agents' }, { id: 'C02', name: 'release-notes', mode: 'read' }]);
    assert.deepEqual(saved.channel_lists, config.channel_lists);
    // A config from before the lists allows every channel it holds: the new one stays out of that.
    assert.deepEqual(applyChange({ ...config, channel_lists: undefined }, reading).channel_lists, { allow: ['dev-agents'], ask: [], deny: [] });

    const closed = applyChange(config, { tab: 'channels', side: 'write', value: 'deny', key: 'dev-agents', source: channels[1] });
    assert.deepEqual(closed, { channels: config.channels, channel_lists: { allow: [], ask: [], deny: [] } });
});

test('a person\'s read stays where it was when write changes, and keeps an entry the screen did not show', () => {
    const allowed = applyChange(config, { tab: 'dm', side: 'write', value: 'allow', key: 'gokce.y', source: people[1] });
    assert.deepEqual(allowed.dm, { allow: ['ellis', 'gokce.y'], ask: [], deny: ['gone.person'] });
    assert.equal(dmReadVerdict({ ...config, ...allowed }, 'gokce.y'), 'deny');

    const denied = applyChange(config, { tab: 'dm', side: 'write', value: 'deny', key: 'ellis', source: people[2] });
    assert.deepEqual(denied.dm.allow, []);
    assert.equal(dmReadVerdict({ ...config, ...denied }, 'ellis'), 'allow');

    const asking = applyChange(config, { tab: 'dm', side: 'read', value: 'ask', key: 'ellis', source: people[2] });
    assert.deepEqual(asking.dm, config.dm);
    assert.deepEqual(asking.dm_read, { allow: [], ask: ['ellis'], deny: [] });
});

test('a channel on read is collected even when an old session switched it off', () => {
    const channel = { id: 'C01', name: 'dev-agents', mode: 'read' };
    assert.deepEqual(pollableChannels({ channels: [channel], scopes: { 'old-session': { 'dev-agents': 'off' } } }), [channel]);
    assert.deepEqual(pollableChannels({ channels: [{ id: 'C01', name: 'dev-agents' }], scopes: { 'old-session': { 'dev-agents': 'off' } } }), []);
});

const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, '');

test('the screen names the tabs, the search box, the columns and the keys, and marks the cell under the cursor', () => {
    const state = keys(openScreen({ config, channels, people }), 'down', 'right');
    const lines = render(state, { rows: 12, columns: 100, color: false });
    assert.equal(lines.length, 12);
    assert.equal(lines[0], 'Agent-Wire   Channels | Direct-Message (DM) ');
    assert.equal(lines[2], 'Search: _   2/2');
    assert.equal(lines[4], '  Read   Write  Channel');
    assert.equal(lines[5], '  deny   allow  dev-agents (public)');
    assert.equal(lines[6], '› deny   DENY   release-notes (private)');
    assert.equal(lines.at(-1), 'Tab switch · ↑↓←→ move · Enter change · type to search · Esc close');
    assert.ok(lines.every((line) => line.length <= 100));
    assert.ok(render(state, { rows: 12, columns: 20, color: false }).every((line) => line.length <= 20));

    // Colour only paints: the same text, with the cell under the cursor as a box and not in capitals.
    const painted = render(state, { rows: 12, columns: 100, color: true });
    assert.deepEqual(painted.map(plain), lines.map((line) => line.replace('DENY', 'deny').replace('Search: _', 'Search:  ')));
    assert.equal(painted.filter((line) => line.includes('\x1b[48;5;238m')).length, 1);
});

test('a list longer than the window scrolls with the cursor', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `U${index + 10}`, handle: `p${String(index).padStart(2, '0')}`, name: `Person ${String(index).padStart(2, '0')}` }));
    let state = press(openScreen({ config: { ...config, dm: undefined }, channels, people: many }), { name: 'tab' });
    for (let step = 0; step < 39; step++) state = press(state, { name: 'down' });
    const lines = render(state, { rows: 12, columns: 80, color: false });
    assert.equal(lines.length, 12);
    assert.equal(lines.filter((line) => line.startsWith('›')).length, 1);
    assert.ok(lines.some((line) => line.includes('Person 39')));
});

const terminal = () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
    const output = Object.assign(new PassThrough(), { isTTY: true, rows: 12, columns: 80 });
    let shown = '';
    output.on('data', (chunk) => { shown += chunk; });
    return { input, output, shown: () => shown };
};
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('with no terminal there is no screen, so an agent\'s shell tool cannot change a cell with it', async () => {
    saveConfig(config);
    const { input, output } = terminal();
    input.isTTY = false;
    assert.equal(await runScreen({ input, output, load: async () => ({ ok: true, channels, people }) }), null);
    assert.deepEqual(loadConfig().dm, config.dm);
});

test('enter writes the change at once; moving and closing write nothing', async () => {
    saveConfig(config);
    const looking = terminal();
    const leaving = runScreen({ input: looking.input, output: looking.output, load: async () => ({ ok: true, channels, people }) });
    await settled();
    looking.input.write('\x1b[B');
    looking.input.write('\x1b[C');
    looking.input.write('\x03');
    assert.equal(await leaving, 0);
    assert.match(looking.shown(), /Agent-Wire/);
    assert.deepEqual(loadConfig(), config);

    const changing = terminal();
    const open = runScreen({ input: changing.input, output: changing.output, load: async () => ({ ok: true, channels, people }) });
    await settled();
    changing.input.write('\x1b[B');
    changing.input.write('\r');
    await settled();
    assert.deepEqual(loadConfig().channels, [{ id: 'C01', name: 'dev-agents' }, { id: 'C02', name: 'release-notes', mode: 'read' }], 'saved while the screen is still open');
    changing.input.write('\x1b[C');
    changing.input.write('\r');
    changing.input.write('\x03');
    assert.equal(await open, 0);
    assert.deepEqual(loadConfig().channel_lists, { allow: ['dev-agents', 'release-notes'], ask: [], deny: [] });
});

test('a host that draws the screen itself gets its first state and saves one change', async () => {
    saveConfig(config);
    const loaded = await loadScreen(async () => ({ ok: true, channels, people }));
    assert.equal(loaded.ok, true);
    const changed = press(press(loaded.state, { name: 'down' }), { name: 'return' });
    saveChange(changed.change);
    assert.deepEqual(loadConfig().channels, [{ id: 'C01', name: 'dev-agents' }, { id: 'C02', name: 'release-notes', mode: 'read' }]);
    assert.deepEqual(await loadScreen(async () => ({ ok: false, reason: 'Slack said: no' })), { ok: false, reason: 'Slack said: no' });
});
