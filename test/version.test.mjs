import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { paths } = await import('../src/config.mjs');
const { installedVersion, isNewer, knownLatest, updateNotice } = await import('../src/version.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const publish = (version) => writeFileSync(paths.update, JSON.stringify({ version, at: Date.now() }));

test('a version is newer only when a number in it is', () => {
    assert.equal(isNewer('0.13.6', '0.13.5'), true);
    assert.equal(isNewer('0.14.0', '0.13.99'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.13.5', '0.13.5'), false);
    assert.equal(isNewer('0.13.4', '0.13.5'), false, 'the registry going backwards is not an upgrade');
});

test('anything that is not three numbers is not comparable', () => {
    assert.equal(isNewer('0.14.0-beta.1', '0.13.5'), false, 'a prerelease is not an upgrade nobody asked for');
    assert.equal(isNewer('latest', '0.13.5'), false);
    assert.equal(isNewer(undefined, '0.13.5'), false);
    assert.equal(isNewer('0.13.6', 'unknown'), false);
});

test('the notice names both versions, and says nothing when there is nothing to say', () => {
    publish('99.0.0');
    const notice = updateNotice();
    assert.match(notice, /99\.0\.0/);
    assert.match(notice, new RegExp(installedVersion().replace(/\./g, '\\.')));
    assert.match(notice, /agent-wire update/);

    publish(installedVersion());
    assert.equal(updateNotice(), null, 'the current version is not news');
});

test('a check that never succeeded says nothing rather than guessing', () => {
    rmSync(paths.update, { force: true });

    assert.equal(knownLatest(), null);
    assert.equal(updateNotice(), null);
});
