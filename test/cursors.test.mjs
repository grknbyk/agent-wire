import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// inbox.mjs reaches config.mjs, which reads HOME once at import time.
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { paths } = await import('../src/config.mjs');
const { readCursor, writeCursor } = await import('../src/inbox.mjs');
const { lastPoll } = await import('../src/status.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a cursors file full of NUL bytes reads as no cursor and is moved aside', () => {
    writeFileSync(paths.cursors, Buffer.alloc(69));

    assert.equal(readCursor('C1'), null);
    assert.equal(existsSync(paths.cursors), false);
    assert.equal(readdirSync(home).filter((name) => name.startsWith('cursors.json.corrupt-')).length, 1);
});

test('a cursor can be written over a corrupt file', () => {
    writeFileSync(paths.cursors, Buffer.alloc(16));

    writeCursor('C1', '1791805810.171749');

    assert.equal(readCursor('C1'), '1791805810.171749');
});

test('a fresh heartbeat is not a sync', () => {
    writeFileSync(paths.pollLock, `4242:${Date.now()}`);
    assert.equal(lastPoll(), 'never');

    writeFileSync(paths.synced, String(Date.now()));
    assert.notEqual(lastPoll(), 'never');
});
