// `agent-wire login`: connect your own Slack account in the browser, no token to copy.
//
// OAuth with PKCE (the app is a public client), so no client secret ships with agent-wire:
// the browser opens Slack's consent page, Slack returns to a one-shot server on localhost,
// and the code is exchanged for the person's user token with the verifier only this process
// knows. The token is checked to be a user token of this workspace, then saved.
//
// The app needs, under OAuth & Permissions: the redirect URL below, the user scopes below,
// and PKCE switched on.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadConfig, patchConfig, paths, readJson, withLock, writeJson } from './config.mjs';
import { slackClient } from './slack.mjs';

// A plain user token, or the rotating one Slack issues to a PKCE app that returns to localhost.
const USER_TOKEN = /^(xoxe\.)?xoxp-/;

// What the token is allowed to be: a user token of this workspace. Returned as a reason
// rather than thrown, so the command can say it in one line.
export async function checkUserToken(token, config, client = slackClient(token)) {
    if (!USER_TOKEN.test(token)) return { ok: false, reason: 'that is not a user token (it starts with xoxp-)' };
    const result = await client.form('auth.test', {});
    if (!result.ok) return { ok: false, reason: `Slack refused it: ${result.error}` };
    if (config.team_id && result.team_id !== config.team_id) {
        return { ok: false, reason: `it belongs to ${result.team}, not to ${config.team}` };
    }
    return { ok: true, userId: result.user_id, user: result.user, team: result.team, teamId: result.team_id };
}

export const LOGIN_PORT = 53682;
export const REDIRECT_URI = `http://localhost:${LOGIN_PORT}/callback`;
export const USER_SCOPES = [
    'chat:write', 'channels:history', 'groups:history', 'channels:read', 'groups:read', 'users:read', 'files:read', 'files:write', 'im:write', 'im:history',
];
// Long enough for a person to find the tab and click Allow, short enough that a forgotten
// login does not hold the port.
const WAIT_MS = 5 * 60_000;

const base64url = (bytes) => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

export function authorizeUrl({ clientId, teamId, state, challenge }) {
    const query = new URLSearchParams({
        client_id: clientId,
        user_scope: USER_SCOPES.join(','),
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    if (teamId) query.set('team', teamId);
    return `https://slack.com/oauth/v2/authorize?${query}`;
}

// No shell between us and the URL: its & would split the command on Windows.
export function openBrowser(url) {
    const [command, args] = process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
}

// Listens first and resolves once the port is held, so the browser is never sent to a
// callback nobody answers (a busy port opened the consent page for nothing, 04.11). The
// returned code promise then resolves with what Slack sends back for this login's state.
export async function listenForCode(state) {
    // Loaded here and not at the top: node:http costs about 17 ms to load, login.mjs is imported by every
    // prompt's drain and every MCP server start, and only a login ever listens (measured 05.11).
    const { createServer } = await import('node:http');
    let listening;
    const ready = new Promise((resolve, reject) => { listening = { resolve, reject }; });
    const code = new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            const url = new URL(request.url, REDIRECT_URI);
            if (url.pathname !== '/callback') {
                response.writeHead(404).end();
                return;
            }
            const finish = (status, page, outcome) => {
                response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(`<p>${page}</p>`);
                clearTimeout(timer);
                server.close();
                outcome();
            };
            // A tab left over from an earlier login answers with that login's state. It is
            // refused, and this login keeps waiting for its own tab (an old tab ended the
            // whole login on 04.11).
            if (url.searchParams.get('state') !== state) {
                response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
                    .end('<p>agent-wire: this tab belongs to an earlier login. Use the newest Slack tab, or close this one.</p>');
                return;
            }
            const error = url.searchParams.get('error');
            if (error) return finish(400, `agent-wire: Slack said ${error}.`, () => reject(new Error(error)));
            if (!url.searchParams.get('code')) {
                return finish(400, 'agent-wire: Slack sent no code back.', () => reject(new Error('Slack sent no code back')));
            }
            return finish(200, 'agent-wire: connected. You can close this tab.', () => resolve(url.searchParams.get('code')));
        });
        const timer = setTimeout(() => {
            server.close();
            reject(new Error('nobody answered in the browser within 5 minutes'));
        }, WAIT_MS);
        server.on('error', (error) => {
            clearTimeout(timer);
            const failure = error.code === 'EADDRINUSE' ? new Error(`port ${LOGIN_PORT} is busy; close what holds it and try again`) : error;
            listening.reject(failure);
            reject(failure);
        });
        server.listen(LOGIN_PORT, '127.0.0.1', () => listening.resolve());
    });
    code.catch(() => {});
    return { ready, code };
}

// The person is waiting at a terminal for this answer.
const EXCHANGE_TIMEOUT_MS = 10_000;

export async function exchangeCode({ clientId, code, verifier, post = fetch, timeoutMs = EXCHANGE_TIMEOUT_MS }) {
    let answer;
    try {
        const response = await post('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        answer = await response.json();
    } catch (error) {
        // Said as slackClient says it, so a login without a connection is a reason and not a stack trace.
        return { ok: false, reason: error.name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
    if (!answer.ok) return { ok: false, reason: answer.error };
    const token = answer.authed_user?.access_token;
    if (!token) return { ok: false, reason: 'Slack returned no user token: add the User Token Scopes to the app' };
    return { ok: true, token, ...rotation(answer.authed_user) };
}

// A PKCE app that returns to localhost gets a rotating token (xoxe.xoxp-, about 12 hours) and
// a refresh token, which lapses after 30 days unused. Without these the person would have to
// log in again every morning. Slack documents expires_in as always 43200; an answer without it
// once stamped the token as expiring now, and every call then renewed it again.
const SLACK_TOKEN_SECONDS = 43_200;
const rotation = (user) => (user.refresh_token
    ? { refreshToken: user.refresh_token, expiresAt: Date.now() + (Number(user.expires_in) || SLACK_TOKEN_SECONDS) * 1000 }
    : {});

// Renew this many minutes before the token runs out, so a send never races its expiry.
const RENEW_BEFORE_MS = 10 * 60_000;
// How long one process may hold the right to renew. A refresh token works once (Slack revokes
// it after a short grace period), and the syncer, every session's MCP server and the CLI all
// reach this window together: two renewing at once could leave the loser with a spent refresh
// token. The lease sits in config.json, taken under the file's lock, and lapses on its own if
// its holder dies mid-request.
const RENEW_LEASE_MS = 20_000;
// A Slack that holds the connection open and never answers held the renewal, and with it the
// send, forever (tester, 05.11). Well inside the lease, so a slow answer is given up on before
// a waiter could take the lease and spend the same refresh token.
const RENEW_TIMEOUT_MS = 10_000;
const LEASE_POLL_MS = 250;
// What oauth.v2.access answers when it cannot serve a renewal right now. The refresh token is still
// unspent after one of these, so they are the network's kind of failure and not the login's.
const NOT_NOW_ERRORS = new Set([
    'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout', 'accesslimited', 'team_added_to_org', 'org_login_required',
]);

const needsRenewal = (config) => Boolean(config.user_refresh_token && config.user_token_expires_at)
    && config.user_token_expires_at - Date.now() <= RENEW_BEFORE_MS;
// Still good for a few minutes: a renewal that failed for a reason worth retrying keeps it.
const usable = (config) => (config.user_token_expires_at > Date.now() ? config.user_token : null);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Who renews: the first process to find the token due and no live lease. Everybody else
// waits for its answer in config.json instead of spending the same refresh token. Returns
// the config as it stands once somebody else settled it, the config to renew when the
// lease is ours, or nothing while another process holds it.
const claimRenewal = () => withLock(paths.config, () => {
    const config = readJson(paths.config, {});
    if (!needsRenewal(config) || config.user_refresh_failed) return { settled: config };
    if (config.user_renew_lease_until > Date.now()) return {};
    const leased = { ...config, user_renew_lease_until: Date.now() + RENEW_LEASE_MS };
    writeJson(paths.config, leased);
    return { mine: leased };
});

const settledToken = (config) => (config.user_refresh_failed ? null : config.user_token ?? null);

async function renew(config, post, timeoutMs) {
    let answer;
    try {
        const response = await post('https://slack.com/api/oauth.v2.access', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: config.user_refresh_token, client_id: config.client_id }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        answer = await response.json();
    } catch {
        // The network, not the login (unreachable, or no answer in time): try again on the
        // next call, and post with what is still valid meanwhile.
        patchConfig({ user_renew_lease_until: undefined });
        return usable(config);
    }
    const user = answer.authed_user ?? answer;
    if (answer.ok && user.access_token) {
        const renewed = { user_token: user.access_token, ...renamed(rotation(user)), user_renew_lease_until: undefined };
        patchConfig(renewed);
        return renewed.user_token;
    }
    // A refused refresh (30 days unused, or revoked) is final until the person logs in again:
    // recorded, so the next calls stop asking Slack and drain can say so. An answer that is not
    // final (ok with no token in it, or Slack saying "not now") erases nothing: the old token
    // stays until it lapses and the next call asks again.
    const isFinal = !answer.ok && !NOT_NOW_ERRORS.has(answer.error);
    patchConfig({ user_renew_lease_until: undefined, ...(isFinal ? { user_refresh_failed: answer.error ?? 'refused' } : {}) });
    return isFinal ? null : usable(config);
}

// The user token to post with, renewed first when it is about to expire. Refreshing needs no
// secret on a PKCE app: client id and refresh token. The refresh token is replaced too. Null
// means not logged in, or the login lapsed: nothing is read or posted.
export async function freshUserToken(config, post = fetch, timeoutMs = RENEW_TIMEOUT_MS) {
    if (!config.user_token) return null;
    if (config.user_refresh_failed) return null;
    if (!needsRenewal(config)) return config.user_token;

    const deadline = Date.now() + RENEW_LEASE_MS;
    for (;;) {
        const { settled, mine } = claimRenewal();
        if (settled || mine) {
            const token = settled ? settledToken(settled) : await renew(mine, post, timeoutMs);
            Object.assign(config, readJson(paths.config, {}));
            return token;
        }
        if (Date.now() > deadline) return usable(config);
        await sleep(LEASE_POLL_MS);
    }
}

const renamed = ({ refreshToken, expiresAt }) => ({ user_refresh_token: refreshToken, user_token_expires_at: expiresAt });

// The browser half of a login, shared by setup (no config yet) and login (renewing one).
// Returns what to save, or the reason in one line.
export async function connectAccount({ clientId, teamId, team }) {
    const state = base64url(randomBytes(16));
    const { verifier, challenge } = pkcePair();
    const url = authorizeUrl({ clientId, teamId, state, challenge });
    const { ready, code } = await listenForCode(state);
    let received;
    try {
        await ready;
        console.log('Opening Slack in your browser. If nothing opens, visit:');
        console.log(url);
        openBrowser(url);
        received = await code;
    } catch (error) {
        return { ok: false, reason: error.message };
    }
    const exchanged = await exchangeCode({ clientId, code: received, verifier });
    if (!exchanged.ok) return { ok: false, reason: `Slack said ${exchanged.reason}` };
    const checked = await checkUserToken(exchanged.token, { team_id: teamId, team });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return {
        ok: true,
        user: checked.user,
        saved: {
            client_id: clientId, user_token: exchanged.token, user_id: checked.userId, team: checked.team, team_id: checked.teamId,
            ...renamed(exchanged), user_refresh_failed: undefined, user_renew_lease_until: undefined,
        },
    };
}

export async function runLogin(clientIdArgument) {
    const config = loadConfig();
    if (!config) {
        console.log('Run `agent-wire setup` first.');
        return 1;
    }
    const clientId = clientIdArgument || config.client_id;
    if (clientIdArgument === '--remove') {
        patchConfig({
            user_token: undefined, user_refresh_token: undefined, user_token_expires_at: undefined, user_id: undefined,
            user_refresh_failed: undefined, user_renew_lease_until: undefined,
        });
        console.log('Logged out. agent-wire neither reads nor posts until `agent-wire login` runs again.');
        return 0;
    }
    if (!clientId) {
        console.log('Give the Client ID once (Slack app > Basic Information): agent-wire login <client-id>');
        return 1;
    }
    const connected = await connectAccount({ clientId, teamId: config.team_id, team: config.team });
    if (!connected.ok) {
        console.log(`Not connected: ${connected.reason}.`);
        return 1;
    }
    patchConfig(connected.saved);
    console.log(`Connected. ${config.nickname} now reads and posts as ${connected.user} in Slack.`);
    return 0;
}
