import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { paths } = await import('../src/config.mjs');
const { installArgs, installedVersion, isNewer, knownLatest, lastCheckFailed, npmScript, refreshLatest, runNpm, updateNotice } = await import('../src/version.mjs');

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

test('npm is reached through node, never through a shell', async () => {
    // The old line was `npm cache clean --force && npm i -g …` handed to exec with
    // windowsHide. On Windows that is a hidden cmd.exe installing software from a
    // detached background process, and Defender's SuspExec heuristic blocked one.
    const script = npmScript();
    assert.ok(script, 'npm-cli.js was not found next to this node');
    assert.match(script, /npm-cli\.js$/);

    // A real npm call, so the test fails if the argument shape is wrong rather than
    // only if the path lookup is.
    const answered = await runNpm(['--version']);
    assert.equal(answered.ok, true, `npm refused: ${answered.reason}`);
    assert.match(answered.out, /^\d+\.\d+\.\d+/);
});

test('the install is an argument list, so nothing can be chained onto it', () => {
    // A version arrives off the network. As one string it used to be concatenated
    // into a shell line; as an array element there is no shell to take a && from it.
    assert.deepEqual(installArgs('1.2.3'), ['install', '-g', '@grknbyk/agent-wire@1.2.3']);
    assert.deepEqual(installArgs('9.9.9 && calc'), ['install', '-g', '@grknbyk/agent-wire@9.9.9 && calc']);
});
test('a registry that fails is asked again only hours later, and the known version stands', async () => {
    const { refreshLatest } = await import('../src/version.mjs');
    writeFileSync(paths.update, JSON.stringify({ version: '0.19.1', at: 0 }));
    const real = globalThis.fetch;
    let asked = 0;
    globalThis.fetch = async () => { asked += 1; throw new Error('offline'); };
    try {
        assert.equal(await refreshLatest(), '0.19.1');
        assert.equal(await refreshLatest(), '0.19.1');
        assert.equal(asked, 1, 'the second prompt must not wait for the registry again');
    } finally {
        globalThis.fetch = real;
    }
});

test('a check records whether the registry answered, so an unasked version is not called the newest', async () => {
    const real = globalThis.fetch;
    const answering = (body) => async () => body;
    try {
        globalThis.fetch = async () => { throw new Error('offline'); };
        await refreshLatest({ force: true });
        assert.equal(lastCheckFailed(), true, 'no connection');

        globalThis.fetch = answering({ ok: true, json: async () => ({ version: '1.2.3' }) });
        await refreshLatest({ force: true });
        assert.equal(lastCheckFailed(), false);
        assert.equal(knownLatest(), '1.2.3');

        globalThis.fetch = answering({ ok: false });
        await refreshLatest({ force: true });
        assert.equal(lastCheckFailed(), true, 'an error status');
        assert.equal(knownLatest(), '1.2.3', 'the version known stands');

        globalThis.fetch = answering({ ok: true, json: async () => ({ version: 'latest' }) });
        await refreshLatest({ force: true });
        assert.equal(lastCheckFailed(), true, 'an answer that is no version');
    } finally {
        globalThis.fetch = real;
    }
});
