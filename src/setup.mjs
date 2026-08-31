// Setup is a checklist, not an interrogation. Every step that Slack can confirm
// is confirmed by asking Slack, never by asking the human "did you do it? (y/n)".
// Each completed step is written to the config immediately, so the config file is
// the resume point and quitting halfway costs nothing.
import { createInterface } from 'node:readline/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, patchConfig, paths } from './config.mjs';
import { ensureChannel, probeToken, slackClient } from './slack.mjs';
import { generateKeypair } from './identity.mjs';
import { formatMessage } from './protocol.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(PACKAGE_ROOT, 'manifest.json');
const CALLBACK_PORT = 32771;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const OAUTH_TIMEOUT_MS = 300000;

const MARKS = ['🔥', '⚡', '🌊', '🌱', '🛰️', '🧭', '🪐', '🦉', '🐙', '🦊', '🐝', '🍀'];

const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

const scopeList = () => manifest().oauth_config.scopes.bot.join(',');

// Slack names a failure but not what to do about it. Each cause a real install
// hits gets the sentence the user actually needs.
const EXPLANATIONS = {
    invalid_auth: 'that token was rejected — check you copied the Bot User OAuth Token (starts with xoxb-), not the App-Level or Configuration token',
    account_inactive: 'the token belongs to a deactivated app or workspace',
    token_revoked: 'that token has been revoked; reinstall the app to get a fresh one',
    missing_scope: 'the app is installed but lacks a scope it needs — reinstall it after updating the manifest',
    not_in_channel: 'the bot is not in that channel yet',
    needs_invite: 'this is a private channel, so no app can add itself — type "/invite @agent-wire" in it',
    channel_not_found: 'no channel with that name is visible to the app',
    name_taken: 'a channel with that name already exists but the app cannot see it — invite the bot to it instead',
    restricted_action: 'your workspace does not allow apps to create channels — create it yourself, then re-run setup',
};

const explain = (reason) => EXPLANATIONS[reason] ?? `Slack said: ${reason}`;

function openBrowser(url) {
    const [command, args] = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    execFile(command, args, () => {
        // No browser is a normal state on a remote box; the URL is printed anyway.
    });
}

// The install step confirms itself: Slack redirects to a server we are already
// listening on, so nothing has to be polled and nothing has to be pasted.
function awaitOAuthCode() {
    return new Promise((resolve) => {
        const server = createServer((request, response) => {
            const url = new URL(request.url, CALLBACK_URL);
            const code = url.searchParams.get('code');
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(`<html><body style="font-family:system-ui;background:#af3c02;color:#fff;padding:3rem">
                <h2>${code ? 'agent-wire is connected.' : 'Authorization was cancelled.'}</h2>
                <p>You can close this tab and return to the terminal.</p></body></html>`);
            server.close();
            resolve(code);
        });
        server.listen(CALLBACK_PORT);
        server.on('error', () => resolve(null));
        setTimeout(() => { server.close(); resolve(null); }, OAUTH_TIMEOUT_MS).unref();
    });
}

async function createAppFromManifest(configToken) {
    const client = slackClient(configToken);
    const created = await client.form('apps.manifest.create', { manifest: JSON.stringify(manifest()) });
    if (!created.ok) return { ok: false, reason: created.error };
    return { ok: true, appId: created.app_id, clientId: created.credentials.client_id, clientSecret: created.credentials.client_secret };
}

async function installApp({ clientId, clientSecret }) {
    const authorizeUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}`
        + `&scope=${encodeURIComponent(scopeList())}&redirect_uri=${encodeURIComponent(CALLBACK_URL)}`;
    console.log('\nOpening Slack so you can approve the install. If nothing opens, paste this:');
    console.log(`  ${authorizeUrl}\n`);
    openBrowser(authorizeUrl);

    const code = await awaitOAuthCode();
    if (!code) return { ok: false, reason: 'authorization_timeout' };

    // oauth.v2.access takes the client id and secret in the body, so this is the
    // one call that carries no bearer token and cannot go through slackClient.
    const exchanged = await (await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: CALLBACK_URL }),
    })).json();
    if (!exchanged.ok) return { ok: false, reason: exchanged.error };
    return { ok: true, botToken: exchanged.access_token };
}

async function obtainBotToken(ask) {
    console.log('\nHow do you want to connect?');
    console.log('  1  I already have a bot token (xoxb-...)');
    console.log('  2  Create the Slack app for me   (needs an App Configuration Token)');
    console.log('  3  I will create the app by hand (you paste the manifest into Slack)');
    const choice = (await ask('Choose 1, 2 or 3: ')).trim();

    if (choice === '1') return (await ask('Paste the Bot User OAuth Token: ')).trim();

    if (choice === '2') {
        console.log('\nOpen https://api.slack.com/apps and scroll to "Your App Configuration Tokens".');
        console.log('Generate one, then paste the Access Token (starts with xoxe-) here.');
        const configToken = (await ask('App Configuration Token: ')).trim();
        const app = await createAppFromManifest(configToken);
        if (!app.ok) {
            console.log(`\nCould not create the app: ${explain(app.reason)}`);
            return null;
        }
        console.log(`App created (${app.appId}).`);
        const installed = await installApp(app);
        if (!installed.ok) {
            console.log(`\nInstall did not complete: ${explain(installed.reason)}`);
            return null;
        }
        return installed.botToken;
    }

    console.log(`\nManifest to paste: ${MANIFEST_PATH}`);
    console.log('  1. Open https://api.slack.com/apps/new and choose "From an app manifest"');
    console.log('  2. Pick your workspace, paste that file, confirm');
    console.log('  3. Open "Install App" in the left sidebar and install it');
    console.log('  4. Copy the Bot User OAuth Token\n');
    return (await ask('Paste the Bot User OAuth Token: ')).trim();
}

function defaultNickname() {
    const folder = process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
    return folder.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 20);
}

const markFor = (nickname) => {
    const total = [...nickname].reduce((sum, character) => sum + character.codePointAt(0), 0);
    return MARKS[total % MARKS.length];
};

export async function runSetup() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (question) => rl.question(question);

    try {
        console.log('agent-wire setup\n');
        const existing = loadConfig();
        if (existing?.bot_token) console.log(`Found an existing config at ${paths.config} — re-running will update it.\n`);

        const botToken = await obtainBotToken(ask);
        if (!botToken) return 1;

        const client = slackClient(botToken);
        const token = await probeToken(client);
        if (!token.ok) {
            console.log(`\nToken check failed: ${explain(token.reason)}`);
            return 1;
        }
        console.log(`Connected to ${token.team}.`);
        patchConfig({
            bot_token: botToken,
            team: token.team,
            team_id: token.teamId,
            bot_user_id: token.botUserId,
            installed_at: new Date().toISOString(),
        });

        const answer = await ask('\nChannel for this project [agent-wire]: ');
        const channelName = (answer.trim() || 'agent-wire').replace(/^#/, '');
        const channel = await ensureChannel(client, channelName);
        if (!channel.ok) {
            console.log(`\nChannel not ready: ${explain(channel.reason)}`);
            console.log('Fix that, then run `npx @grknbyk/agent-wire setup` again — it resumes here.');
            return 1;
        }
        console.log(channel.created ? `Created and joined #${channel.name}.` : `Joined #${channel.name}.`);

        const suggested = defaultNickname();
        const nicknameAnswer = await ask(`\nThis agent's name [${suggested}]: `);
        const nickname = (nicknameAnswer.trim() || suggested).toLowerCase();
        const markAnswer = await ask(`Emoji shown before the name [${markFor(nickname)}]: `);

        const keypair = existing?.private_key
            ? { privateKey: existing.private_key, publicKey: existing.public_key }
            : generateKeypair();

        const config = patchConfig({
            nickname,
            mark: markAnswer.trim() || markFor(nickname),
            private_key: keypair.privateKey,
            public_key: keypair.publicKey,
            channels: [{ id: channel.id, name: channel.name }],
        });

        const hello = formatMessage({
            mark: config.mark,
            from: config.nickname,
            to: 'all',
            text: `joined from ${process.platform}. Key ${config.public_key.slice(0, 12)}…`,
        });
        await client.json('chat.postMessage', { channel: channel.id, text: hello });

        console.log(`\nDone. You are ${config.mark} ${config.nickname} in #${channel.name}.`);
        console.log(`Config: ${paths.config}`);
        console.log('\nAdd this to your MCP client (Claude Code: `claude mcp add agent-wire -- npx -y @grknbyk/agent-wire serve`):');
        console.log(JSON.stringify({ mcpServers: { 'agent-wire': { command: 'npx', args: ['-y', 'agent-wire', 'serve'] } } }, null, 2));
        console.log(`\nUpload assets/agent-wire.png as the app icon at https://api.slack.com/apps (Basic Information → Display Information).`);
        return 0;
    } finally {
        rl.close();
    }
}

// The same three probes setup used, read at a later date: a bot kicked from the
// channel, a revoked token and an uninstalled app all surface here.
export async function runDoctor() {
    const config = loadConfig();
    if (!config?.bot_token) {
        console.log('not configured — run `npx @grknbyk/agent-wire setup`');
        return 1;
    }

    const client = slackClient(config.bot_token);
    const token = await probeToken(client);
    console.log(token.ok ? `token      ok (${token.team})` : `token      FAILED — ${explain(token.reason)}`);
    if (!token.ok) return 1;

    console.log(`identity   ${config.mark} ${config.nickname}, key ${config.public_key.slice(0, 12)}…`);

    let failures = 0;
    for (const channel of config.channels ?? []) {
        const probe = await ensureChannel(client, channel.name);
        console.log(probe.ok ? `channel    #${channel.name} ok` : `channel    #${channel.name} FAILED — ${explain(probe.reason)}`);
        if (!probe.ok) failures++;
    }
    return failures === 0 ? 0 : 1;
}
