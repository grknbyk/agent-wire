import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// slack.mjs reaches config.mjs, which reads HOME once at import time.
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { safeName } = await import('../src/slack.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

test('an ordinary filename is left alone', () => {
    assert.equal(safeName('migration-plan.md'), 'migration-plan.md');
});

test('a filename cannot climb out of the download directory', () => {
    assert.equal(safeName('../../.ssh/authorized_keys'), '.._.._.ssh_authorized_keys');
    assert.equal(safeName(String.raw`C:\Windows\System32\evil.dll`), 'C__Windows_System32_evil.dll');
});

test('a filename that sanitises to nothing still gets a name', () => {
    assert.equal(safeName('///'), '___');
    assert.equal(safeName(''), 'file');
    assert.equal(safeName(null), 'file');
});

test('a very long filename is cut, not passed through', () => {
    assert.equal(safeName('a'.repeat(500)).length, 80);
});
