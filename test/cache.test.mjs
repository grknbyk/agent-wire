import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The reads are cached on the file's own mtime and size, so these tests exist to
// prove the cache is invalidated by a write rather than outliving it. Every one of
// them writes and then reads back through the cached path.
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { appendMessages, archive, findByTs, markRead, readCursor, readInbox, selectMessages, writeCursor } =
    await import('../src/inbox.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const message = (ts, overrides = {}) => ({
    ts,
    at: new Date(Number(ts) * 1000).toISOString(),
    channel: 'agent-wire',
    from: 'mira',
    kind: 'agent',
    authorship: 'signed',
    hop: 1,
    text: `message ${ts}`,
    ...overrides,
});

test('a message appended after a read is visible to the next read', () => {
    assert.equal(readInbox().length, 0);

    appendMessages([message('1700000001.0001')]);
    assert.equal(readInbox().length, 1);

    appendMessages([message('1700000002.0001')]);
    assert.equal(readInbox().length, 2);
    assert.equal(selectMessages({ state: 'unread', count: 10 }).length, 2);
});

test('the same timestamp is still refused after the log has been cached', () => {
    const before = readInbox().length;

    assert.equal(appendMessages([message('1700000001.0001')]), 0);
    assert.equal(readInbox().length, before);
});

test('marking read is visible to the very next select', () => {
    const unread = selectMessages({ state: 'unread', count: 10 });
    assert.equal(unread.length, 2);

    markRead(unread);
    assert.equal(selectMessages({ state: 'unread', count: 10 }).length, 0);
    assert.equal(selectMessages({ state: 'read', count: 10 }).length, 2);
});

test('archiving is visible to the very next select', () => {
    assert.equal(archive(), 2);
    assert.equal(selectMessages({ state: 'read', count: 10 }).length, 0);
    assert.equal(selectMessages({ state: 'archived', count: 10 }).length, 2);
});

test('a cursor written is the cursor read back', () => {
    assert.equal(readCursor('C1'), null);

    writeCursor('C1', '1700000002.0001');
    assert.equal(readCursor('C1'), '1700000002.0001');

    writeCursor('C1', '1700000009.0001');
    assert.equal(readCursor('C1'), '1700000009.0001');
});

// selectMessages scans from the newest end and stops at `count`, so this is the
// test that the shortcut still returns the same window the old full filter did.
test('select returns the newest count, oldest first', () => {
    appendMessages([message('1700000003.0001'), message('1700000004.0001'), message('1700000005.0001')]);

    const newest = selectMessages({ state: 'unread', count: 2 });
    assert.deepEqual(newest.map((item) => item.ts), ['1700000004.0001', '1700000005.0001']);
});

test('a channel filter only sees its own channel', () => {
    appendMessages([message('1700000006.0001', { channel: 'agent-wms' })]);

    const wms = selectMessages({ state: 'all', count: 10, channel: 'agent-wms' });
    assert.deepEqual(wms.map((item) => item.ts), ['1700000006.0001']);
});

test('findByTs sees a message appended after the log was cached', () => {
    assert.equal(findByTs('1700000007.0001'), null);

    appendMessages([message('1700000007.0001')]);
    assert.equal(findByTs('1700000007.0001').text, 'message 1700000007.0001');
});
