import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;
process.env.AGENT_WIRE_SCOPE = 'session-under-test';

const { paths, readJson, writeJson } = await import('../src/config.mjs');
const { appendMessages, markRead, selectMessages, sessionStart } = await import('../src/inbox.mjs');
const { deliveryLine, earlierLine } = await import('../src/drain.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const HEARD = ['dev', 'ops'];
const message = (channel, ts) => ({ ts, at: '2026-08-31T00:00:00Z', channel, from: 'mira', kind: 'agent', authorship: 'signed', text: `m${ts}` });
const unread = (from) => selectMessages({ state: 'unread', count: 50, channels: HEARD, from });
const waiting = () => unread(sessionStart(HEARD).from).map((item) => item.ts);

test('a session born into an empty log is given everything that comes', () => {
    assert.deepEqual(sessionStart(HEARD), { from: 0, earlier: 0 });
    appendMessages([message('dev', '99.1')]);
    assert.deepEqual(waiting(), ['99.1']);
});

test('a new session is given what arrives after its first prompt; what was there is counted once and stays unread', () => {
    writeJson(paths.states, {});
    appendMessages([message('dev', '100.1'), message('ops', '90.1'), message('dev', '101.1')]);

    assert.deepEqual(sessionStart(['dev']), { from: 4, earlier: 3 }, 'only the channels this session hears are counted');
    assert.deepEqual(sessionStart(HEARD), { from: 4, earlier: 0 }, 'said once');
    assert.deepEqual(waiting(), []);

    // 91.1 is older than the mark by its ts and still new: arrival decides, not the ts.
    appendMessages([message('ops', '91.1'), message('dev', '102.1')]);
    assert.deepEqual(waiting(), ['91.1', '102.1']);
    markRead(unread(sessionStart(HEARD).from));
    assert.deepEqual(waiting(), []);
    assert.deepEqual(selectMessages({ state: 'unread', count: 50 }).map((item) => item.ts), ['99.1', '100.1', '90.1', '101.1'], 'the inbox tool still opens the earlier ones');
});

test('a session from before the mark existed goes on after the newest message it has read', () => {
    const states = readJson(paths.states, {});
    delete states['session-under-test|since'];
    writeJson(paths.states, states);
    appendMessages([message('dev', '103.1')]);

    assert.deepEqual(sessionStart(HEARD), { from: 6, earlier: 4 });
    assert.deepEqual(waiting(), ['103.1']);
});

test('a log that was replaced under the session starts it again', () => {
    writeFileSync(paths.inbox, `${JSON.stringify(message('dev', '200.1'))}\n`);
    assert.deepEqual(sessionStart(HEARD), { from: 1, earlier: 1 });
});

test('a session that has only its mark is as old as the mark when states are pruned', () => {
    const states = { 'live|since': 'dev:9000.1' };
    for (let index = 0; index < 4000; index++) states[`old|dev:${index + 1}.1`] = 'read';
    for (let index = 0; index < 4001; index++) states[`dead|dev:${index + 5000}.1`] = 'read';
    writeJson(paths.states, states);
    markRead([message('dev', '200.1')]);

    const kept = Object.keys(readJson(paths.states, {}));
    assert.equal(kept.includes('live|since'), true);
    assert.equal(kept.some((key) => key.startsWith('old|')), false, 'the oldest session went instead');
});

test('the line for the earlier messages, as the hook prints it and as a chat shows it', () => {
    assert.equal(earlierLine(1), 'agent-wire: 1 earlier message left unread. Open them only if the user asks: the inbox tool.');
    assert.equal(deliveryLine(earlierLine(775)), 'agent-wire: 775 earlier messages left unread. Open them only if the user asks: the inbox tool.');
});
