// Setup is a checklist, not an interrogation. Every step that Slack can confirm
// is confirmed by asking Slack, never by asking the human "did you do it? (y/n)".
// Each completed step is written to the config immediately, so the config file is
// the resume point and quitting halfway costs nothing.
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, patchConfig, paths } from './config.mjs';
import { joinedChannels, probeToken, slackClient } from './slack.mjs';
import { hookSnippet, hookState, installHook, settingsPath } from './hook.mjs';
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
    needs_invite: 'the bot has not been invited anywhere yet — open a channel in Slack, public or private, and type "/invite @agent-wire" in it',
};

const explain = (reason) => EXPLANATIONS[reason] ?? `Slack said: ${reason}`;

const DELIVERY_REPORT = {
    installed: 'delivery   ok, the prompt hook is installed',
    missing: 'delivery   MISSING — read and ask deliver nothing without the prompt hook',
    unreadable: 'delivery   UNKNOWN — the client settings file is not valid JSON, so the hook cannot be checked',
    'no-client': 'delivery   no Claude Code settings here; another client needs its own hook, and the inbox tool works either way',
};

// The invite is the whole decision, so setup and doctor read the channels the bot
// is in rather than asking a human to type a name correctly. Slack owns the id and
// the name here: a channel renamed after setup would otherwise sit in the config
// under a name that finds nothing, which is what the first install ran into.
// ponytail: a rename drops that channel back to the default mode, because the
// per-session modes are keyed by name. Key them by id when someone minds.
async function adoptChannels(client, config) {
    const joined = await joinedChannels(client);
    if (!joined.ok) return joined;
    if (joined.channels.length === 0) return { ok: false, reason: 'needs_invite' };

    const knownById = new Map((config?.channels ?? []).map((channel) => [channel.id, channel]));
    const channels = joined.channels.map((channel) => ({ ...knownById.get(channel.id), ...channel }));

    patchConfig({ channels });
    return { ok: true, channels, added: channels.filter((channel) => !knownById.has(channel.id)) };
}

const channelList = (channels) => channels.map((channel) => `#${channel.name}`).join(', ');

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

        const adopted = await adoptChannels(client, existing);
        if (!adopted.ok) {
            console.log(`\nNo channel yet: ${explain(adopted.reason)}`);
            console.log('Invite it, then run `npx @grknbyk/agent-wire setup` again — it resumes here.');
            return 1;
        }
        console.log(`In ${channelList(adopted.channels)}.`);

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
        });

        const hello = formatMessage({
            mark: config.mark,
            from: config.nickname,
            to: 'all',
            text: `joined from ${process.platform}. Key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`,
        });
        for (const channel of adopted.channels) {
            await client.json('chat.postMessage', { channel: channel.id, text: hello });
        }

        // Offered rather than written. This is the user's own client config, and
        // every other key in it belongs to somebody else.
        // Not just `missing`: a machine whose client has never written a settings
        // file answers `no-client`, and that is the first install of all — exactly
        // the one that needs the offer. installHook creates the file.
        if (hookState() !== 'installed') {
            console.log('\nread and ask are delivered by a hook that runs before every prompt.');
            console.log('Without it a channel sits on read with messages waiting and never says a word.');
            const answer = await ask(`Add it to ${settingsPath()}? [Y/n]: `);
            if (/^n/i.test(answer.trim())) {
                console.log('Skipped. `agent-wire doctor` prints the snippet whenever you want it.');
            } else {
                const written = installHook();
                console.log(written.ok
                    ? `Added.${written.backedUp ? ' The previous file is kept as settings.json.agent-wire.bak.' : ''} Restart the client to pick it up.`
                    : `Not added: ${written.reason}`);
            }
        }

        console.log(`\nDone. You are ${config.mark} ${config.nickname} in ${channelList(adopted.channels)}.`);
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
        console.log('not configured yet — run `agent-wire setup`');
        return 1;
    }

    const client = slackClient(config.bot_token);
    const token = await probeToken(client);
    console.log(token.ok ? `token      ok (${token.team})` : `token      FAILED — ${explain(token.reason)}`);
    if (!token.ok) return 1;

    // A token written, an identity not yet: setup was quit between the two steps,
    // which it invites you to do. Doctor crashed here instead of saying so.
    if (!config.public_key) {
        console.log('identity   MISSING — setup stopped before naming this agent; run it again');
        return 1;
    }
    console.log(`identity   ${config.mark} ${config.nickname}, key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`);

    const adopted = await adoptChannels(client, config);
    if (!adopted.ok) {
        console.log(`channel    FAILED — ${explain(adopted.reason)}`);
        return 1;
    }

    const isNew = new Set(adopted.added.map((channel) => channel.id));
    for (const channel of adopted.channels) {
        console.log(`channel    #${channel.name} ok${isNew.has(channel.id) ? ' (new, added to config)' : ''}`);
    }

    // The mode is a setting; the hook is what acts on it. A channel reading `read`
    // with five unread and no hook behind it says the thing is working when it has
    // not delivered a word, so this is a failure and not a note.
    const delivery = hookState();
    console.log(DELIVERY_REPORT[delivery]);
    if (delivery === 'missing') {
        console.log(`\nAdd this to ${settingsPath()}, or re-run setup:\n${hookSnippet()}`);
        return 1;
    }
    return 0;
}
