import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;
const { freshUserToken, listenForCode, LOGIN_PORT } = await import('../src/login.mjs');
const { loadConfig, saveConfig } = await import('../src/config.mjs');
const { loginLapsedNotice } = await import('../src/drain.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const MINUTE = 60_000;
// A token five minutes from expiry: inside the renewal window.
const due = (overrides = {}) => {
    const config = { version: 1, client_id: '1.2', user_token: 'xoxe.xoxp-old', user_refresh_token: 'r-old', user_token_expires_at: Date.now() + 5 * MINUTE, ...overrides };
    saveConfig(config);
    return { ...config };
};
const answering = (body, calls = []) => async (url, request) => {
    calls.push(Object.fromEntries(request.body));
    return { json: async () => body };
};
const renewedBody = { ok: true, authed_user: { access_token: 'xoxe.xoxp-new', refresh_token: 'r-new', expires_in: 43200 } };

test('a renewal saves the new pair and returns the new token', async () => {
    const calls = [];
    assert.equal(await freshUserToken(due(), answering(renewedBody, calls)), 'xoxe.xoxp-new');
    assert.equal(calls[0].refresh_token, 'r-old');
    assert.equal(loadConfig().user_refresh_token, 'r-new');
    assert.equal(loadConfig().user_renew_lease_until, undefined, 'the lease is released');
});

test('two processes due at once renew once: the refresh token is spent by the first', async () => {
    due();
    const calls = [];
    const slow = async (url, request) => {
        calls.push(Object.fromEntries(request.body));
        await new Promise((resolve) => { setTimeout(resolve, 600); });
        return { json: async () => renewedBody };
    };
    const tokens = await Promise.all([freshUserToken(loadConfig(), slow), freshUserToken(loadConfig(), slow)]);
    assert.deepEqual(tokens, ['xoxe.xoxp-new', 'xoxe.xoxp-new']);
    assert.equal(calls.length, 1);
});

test('a lease left by a process that died is taken once it lapses', async () => {
    due({ user_renew_lease_until: Date.now() - 1 });
    assert.equal(await freshUserToken(loadConfig(), answering(renewedBody)), 'xoxe.xoxp-new');
});

test('a network failure keeps the still-valid token and throws nothing', async () => {
    const config = due();
    const offline = async () => { throw new TypeError('fetch failed'); };
    assert.equal(await freshUserToken(config, offline), 'xoxe.xoxp-old');
    assert.equal(loadConfig().user_refresh_failed, undefined, 'the network is not the login: retried next call');
    assert.equal(loadConfig().user_renew_lease_until, undefined);
    assert.equal(await freshUserToken(due({ user_token_expires_at: Date.now() - MINUTE }), offline), null, 'expired: the bot posts');
});

test('a Slack that never answers is given up on, the lease freed and the valid token kept', async () => {
    // Answers only by being aborted: without a signal it would hold the call for good.
    const silent = (url, request) => new Promise((resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal.reason));
    });
    const held = new Promise((resolve) => { setTimeout(resolve, 2000, 'still waiting after 2 s'); });
    assert.equal(await Promise.race([freshUserToken(due(), silent, 200), held]), 'xoxe.xoxp-old');
    assert.equal(loadConfig().user_renew_lease_until, undefined);
    assert.equal(loadConfig().user_refresh_failed, undefined, 'retried on the next call');
});

test('Slack saying "not now" does not end the login: the token stays and the next call asks again', async () => {
    for (const error of ['ratelimited', 'service_unavailable', 'internal_error']) {
        assert.equal(await freshUserToken(due(), answering({ ok: false, error })), 'xoxe.xoxp-old', error);
        assert.equal(loadConfig().user_refresh_failed, undefined, `${error} is not the login's fault`);
        assert.equal(loadConfig().user_renew_lease_until, undefined);
    }
    const expired = due({ user_token_expires_at: Date.now() - MINUTE });
    assert.equal(await freshUserToken(expired, answering({ ok: false, error: 'ratelimited' })), null, 'expired: nothing to post with yet');
    assert.equal(loadConfig().user_refresh_failed, undefined);
});

test('an ok answer without a token erases nothing', async () => {
    assert.equal(await freshUserToken(due(), answering({ ok: true })), 'xoxe.xoxp-old');
    assert.equal(loadConfig().user_token, 'xoxe.xoxp-old');
    assert.equal(loadConfig().user_refresh_token, 'r-old');
});

test('a refused renewal is recorded, not asked again, and drain says so', async () => {
    const calls = [];
    const refused = answering({ ok: false, error: 'invalid_refresh_token' }, calls);
    assert.equal(await freshUserToken(due(), refused), null);
    assert.equal(await freshUserToken(loadConfig(), refused), null);
    assert.equal(calls.length, 1);
    assert.equal(loadConfig().user_refresh_failed, 'invalid_refresh_token');
    assert.match(loginLapsedNotice(loadConfig()), /login lapsed \(invalid_refresh_token\).*agent-wire login/);
    assert.equal(loginLapsedNotice({ user_token: 'x' }), null);
});

test('an answer without expires_in counts as Slack\'s twelve hours, not as expired', async () => {
    const body = { ok: true, authed_user: { access_token: 'xoxe.xoxp-new', refresh_token: 'r-new' } };
    await freshUserToken(due(), answering(body));
    const left = loadConfig().user_token_expires_at - Date.now();
    assert.ok(left > 11 * 60 * MINUTE && left <= 12 * 60 * MINUTE, `${left} ms left`);
});

test('a callback with the right state and no code ends the login with a reason', async () => {
    const { ready, code } = await listenForCode('s1');
    await ready;
    const response = await fetch(`http://127.0.0.1:${LOGIN_PORT}/callback?state=s1`);
    assert.equal(response.status, 400);
    await assert.rejects(code, /no code/);
});
