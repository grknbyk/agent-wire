// Setup is a checklist, not an interrogation. Every step that Slack can confirm
// is confirmed by asking Slack, never by asking the human "did you do it? (y/n)".
// Each completed step is written to the config immediately, so the config file is
// the resume point and quitting halfway costs nothing.
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, patchConfig, paths } from './config.mjs';
import { probeChannel, probeToken, slackClient } from './slack.mjs';
import { FINGERPRINT_CHARS, generateKeypair } from './identity.mjs';
import { formatMessage } from './protocol.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(PACKAGE_ROOT, 'manifest.json');

const MARKS = ['🔥', '⚡', '🌊', '🌱', '🛰️', '🧭', '🪐', '🦉', '🐙', '🦊', '🐝', '🍀'];

// Slack names a failure but not what to do about it. Each cause a real install
// hits gets the sentence the user actually needs.
const EXPLANATIONS = {
    invalid_auth: 'that token was rejected — check you copied the Bot User OAuth Token (starts with xoxb-), not the App-Level or Configuration token',
    account_inactive: 'the token belongs to a deactivated app or workspace',
    token_revoked: 'that token has been revoked; reinstall the app to get a fresh one',
    missing_scope: 'the app is installed but lacks a scope it needs — reinstall it after updating the manifest',
    not_in_channel: 'the bot is not in that channel yet — type "/invite @agent-wire" in it',
    needs_invite: 'the bot is in no channel by that name — create it in Slack if it does not exist, then type "/invite @agent-wire" in it',
};

const explain = (reason) => EXPLANATIONS[reason] ?? `Slack said: ${reason}`;

// One path, by hand. Slack's own OAuth redirect needs a localhost listener, and a
// listener is the part that breaks: a busy port, a firewall prompt, a headless
// box. Pasting a token you can see beats a handshake you cannot debug.
async function obtainBotToken(ask) {
    console.log(`\nManifest to paste: ${MANIFEST_PATH}`);
    console.log('  1. Open https://api.slack.com/apps/new and choose "From an app manifest"');
    console.log('  2. Pick your workspace, paste that file, confirm');
    console.log('  3. Open "Install App" in the left sidebar and install it');
    console.log('  4. Copy the Bot User OAuth Token');
    console.log('  5. Create the channel in Slack and type "/invite @agent-wire" in it\n');
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
    // Setup is a conversation, so it needs a terminal on the other end. Without
    // one, stdin reaches end of file before the first answer and rl.question()
    // waits for a line that can never arrive: the process hangs with no output.
    if (!process.stdin.isTTY) {
        console.log('agent-wire setup needs an interactive terminal.');
        console.log('Run it directly in your shell, not through a pipe, a script or an editor task.');
        return 1;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // A terminal can still close mid-answer, on Ctrl-D or a lost session. Race
    // the question against that, or the same silent hang comes back.
    const ask = (question) => Promise.race([
        rl.question(question),
        new Promise((_, reject) => rl.once('close', () => reject(new Error('input closed')))),
    ]);

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
        const channel = await probeChannel(client, channelName);
        if (!channel.ok) {
            console.log(`\nChannel not ready: ${explain(channel.reason)}`);
            console.log('Fix that, then run `npx @grknbyk/agent-wire setup` again — it resumes here.');
            return 1;
        }
        console.log(`Found #${channel.name}, the bot is in it.`);

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
            text: `joined from ${process.platform}. Key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`,
        });
        await client.json('chat.postMessage', { channel: channel.id, text: hello });

        console.log(`\nDone. You are ${config.mark} ${config.nickname} in #${channel.name}.`);
        console.log(`Config: ${paths.config}`);
        console.log('\nAdd this to your MCP client (Claude Code: `claude mcp add agent-wire -- npx -y @grknbyk/agent-wire serve`):');
        console.log(JSON.stringify({ mcpServers: { 'agent-wire': { command: 'npx', args: ['-y', '@grknbyk/agent-wire', 'serve'] } } }, null, 2));
        console.log(`\nUpload assets/agent-wire.png as the app icon at https://api.slack.com/apps (Basic Information → Display Information).`);
        return 0;
    } catch (error) {
        if (error.message !== 'input closed') throw error;

        console.log('\nStopped: no more input. Re-run setup — it resumes where it left off.');
        return 1;
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

    console.log(`identity   ${config.mark} ${config.nickname}, key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`);

    let failures = 0;
    for (const channel of config.channels ?? []) {
        const probe = await probeChannel(client, channel.name);
        console.log(probe.ok ? `channel    #${channel.name} ok` : `channel    #${channel.name} FAILED — ${explain(probe.reason)}`);
        if (!probe.ok) failures++;
    }
    return failures === 0 ? 0 : 1;
}
