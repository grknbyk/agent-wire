import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { paths } = await import('../src/config.mjs');
const { syncEveryMs, syncerIsLive } = await import('../src/sync.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const heldAt = (when) => writeFileSync(paths.pollLock, `4242:${when}`);

test('a config that says nothing about syncing syncs once a minute', () => {
    assert.equal(syncEveryMs({}), 60000);
    assert.equal(syncEveryMs(undefined), 60000);
    assert.equal(syncEveryMs({ sync_seconds: null }), 60000);
});

test('sync_seconds is honoured, and a typo in it cannot hammer the workspace', () => {
    assert.equal(syncEveryMs({ sync_seconds: 30 }), 30000);
    assert.equal(syncEveryMs({ sync_seconds: 300 }), 300000);

    // One token is shared by the whole team, so the floor is not negotiable.
    assert.equal(syncEveryMs({ sync_seconds: 1 }), 5000, 'a 1-second sync is clamped to the floor');
    assert.equal(syncEveryMs({ sync_seconds: 0 }), 60000, 'zero reads as unset, not as "never wait"');
    assert.equal(syncEveryMs({ sync_seconds: -10 }), 60000);
    assert.equal(syncEveryMs({ sync_seconds: 'every minute' }), 60000);
});

test('no lock file means no syncer, rather than a crash', () => {
    try {
        unlinkSync(paths.pollLock);
    } catch {
        // It was not there, which is the state this test wants.
    }
    // The subtraction gives NaN here, and NaN is not less than the threshold.
    assert.equal(syncerIsLive(), false);
});

test('a beating lock is a live syncer and a cold one is not', () => {
    heldAt(Date.now());
    assert.equal(syncerIsLive(), true);

    heldAt(Date.now() - 12000);
    assert.equal(syncerIsLive(), true, 'one missed beat is not a dead syncer');

    // Past this, a prompt hook spawns a replacement. The heartbeat is every 10s,
    // so three missed beats is the point where nobody is feeding the log.
    heldAt(Date.now() - 31000);
    assert.equal(syncerIsLive(), false);
});

test('a lock written by a crashed syncer does not keep the log starved forever', () => {
    heldAt(Date.now() - 600000);
    assert.equal(syncerIsLive(), false, 'a ten-minute-old lock must not look alive');
});
