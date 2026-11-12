import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENT_WIRE_HOME = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
const { REDIRECT_URI, authorizeUrl, exchangeCode, pkcePair } = await import('../src/login.mjs');

test('the challenge is the S256 of the verifier, in base64url', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
});

test('the consent page asks for user scopes, PKCE and this workspace', () => {
    const url = new URL(authorizeUrl({ clientId: '1.2', teamId: 'T1', state: 's', challenge: 'c' }));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('team'), 'T1');
    assert.match(url.searchParams.get('user_scope'), /chat:write/);
    assert.equal(url.searchParams.get('scope'), null, 'no bot scopes: this is a person connecting');
});

test('the exchange sends the verifier and no secret, and takes the user token', async () => {
    let sent;
    const post = async (_url, request) => { sent = Object.fromEntries(request.body); return { json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-1' } }) }; };
    assert.deepEqual(await exchangeCode({ clientId: '1.2', code: 'k', verifier: 'v', post }), { ok: true, token: 'xoxp-1' });
    assert.equal(sent.code_verifier, 'v');
    assert.equal(sent.client_secret, undefined);
    const refused = async () => ({ json: async () => ({ ok: false, error: 'invalid_code' }) });
    assert.deepEqual(await exchangeCode({ clientId: '1.2', code: 'k', verifier: 'v', post: refused }), { ok: false, reason: 'invalid_code' });
});

test('a login with no connection says so instead of throwing', async () => {
    const offline = async () => { throw new TypeError('fetch failed'); };
    assert.deepEqual(await exchangeCode({ clientId: '1.2', code: 'k', verifier: 'v', post: offline }), { ok: false, reason: 'network_error' });
    const silent = (url, request) => new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
    });
    assert.deepEqual(await exchangeCode({ clientId: '1.2', code: 'k', verifier: 'v', post: silent, timeoutMs: 50 }), { ok: false, reason: 'timeout' });
});

test('a rotating token is renewed shortly before it expires, and kept until then', async () => {
    const { freshUserToken } = await import('../src/login.mjs');
    // config.json is where processes agree on who renews, so each case starts from the file.
    const { saveConfig } = await import('../src/config.mjs');
    const saved = (config) => { saveConfig(config); return config; };
    let calls = 0;
    const post = async (_url, request) => {
        calls++;
        assert.equal(Object.fromEntries(request.body).grant_type, 'refresh_token');
        return { json: async () => ({ ok: true, access_token: 'xoxe.xoxp-2', refresh_token: 'xoxe-1-b', expires_in: 43200 }) };
    };
    const fresh = { client_id: '1.2', user_token: 'xoxe.xoxp-1', user_refresh_token: 'xoxe-1-a', user_token_expires_at: Date.now() + 3600_000 };
    assert.equal(await freshUserToken(fresh, post), 'xoxe.xoxp-1');
    assert.equal(calls, 0);
    const stale = saved({ ...fresh, user_token_expires_at: Date.now() + 60_000 });
    assert.equal(await freshUserToken(stale, post), 'xoxe.xoxp-2');
    assert.equal(stale.user_refresh_token, 'xoxe-1-b');
    const refused = async () => ({ json: async () => ({ ok: false, error: 'invalid_refresh_token' }) });
    assert.equal(await freshUserToken(saved({ ...fresh, user_token_expires_at: Date.now() - 1000 }), refused), null, 'the bot posts until the next login');
});
