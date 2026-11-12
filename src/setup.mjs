// Setup is a checklist, not an interrogation. Every step that Slack can confirm
// is confirmed by asking Slack, never by asking the human "did you do it? (y/n)".
// Each completed step is written to the config immediately, so the config file is
// the resume point and quitting halfway costs nothing.
//
// There is no bot: the person logs in with their own Slack account (agent-wire login, in the
// browser), picks the channels agent-wire uses from the ones they are in, and setup plugs it
// into the clients it finds here, Claude Code and pi (owner, 05.11).
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig, patchConfig, paths } from './config.mjs';
import { joinedChannels, probeToken, slackClient } from './slack.mjs';
import { hookSnippet, hookState, installHook, settingsPath } from './hook.mjs';
import { installedVersion, lastCheckFailed, refreshLatest, updateNotice } from './version.mjs';
import { FINGERPRINT_CHARS, generateKeypair } from './identity.mjs';
import { formatMessage, isNickname } from './protocol.mjs';
import { connectAccount, freshUserToken, openBrowser } from './login.mjs';
import { claudeState, installClaude, installPi, piExtension, piState } from './clients.mjs';
import { LISTS, channelLists } from './policy.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(PACKAGE_ROOT, 'manifest.json');

// The steps for creating the Slack app, as plain text a person reads or their agent fetches.
const APP_GUIDE = 'https://raw.githubusercontent.com/grknbyk/agent-wire/main/docs/slack-app.md';

// Slack's own "create an app" page with this manifest already filled in, so nothing is pasted.
export const createAppUrl = () => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))))}`;

// Slack names a failure but not what to do about it. Each cause a real install
// hits gets the sentence the user actually needs.
const EXPLANATIONS = {
    invalid_auth: 'the login was rejected — run `agent-wire login` again',
    account_inactive: 'the account or the workspace has been deactivated',
    token_revoked: 'the login has been revoked — run `agent-wire login` again',
    missing_scope: 'the login lacks a scope it needs — add it to the app (manifest.json), then run `agent-wire login` again',
    no_channels: 'you are in no channel yet — join or create the channel for your agents in Slack, then run setup again',
};

const explain = (reason) => EXPLANATIONS[reason] ?? `Slack said: ${reason}`;

const DELIVERY_REPORT = {
    installed: 'delivery   ok, the prompt hook is installed',
    missing: 'delivery   MISSING — read and ask deliver nothing without the prompt hook',
    broken: 'delivery   BROKEN — the prompt hook names a file that is gone, so nothing is delivering',
    unreadable: 'delivery   UNKNOWN — the client settings file is not valid JSON, so the hook cannot be checked',
    'no-client': 'delivery   no Claude Code settings here; another client needs its own hook, and the inbox tool works either way',
};

const PI_REPORT = {
    installed: 'pi         ok, the extension is installed',
    stale: 'pi         OLD — the extension is an older copy: run setup again',
    absent: 'pi         not installed — run setup again to add the extension',
};

const CLAUDE_REPORT = {
    installed: 'claude     ok, the MCP server is registered',
    absent: 'claude     not registered — run setup again, or: claude mcp add -s user agent-wire -- agent-wire serve',
};

const channelList = (channels) => channels.map((channel) => `#${channel.name}`).join(', ');

function defaultNickname() {
    const folder = process.cwd().split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
    return folder.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 20);
}

// "1,3" or "1 3" into the channels at those places; anything unreadable is null.
export function pickChannels(answer, joined) {
    const numbers = answer.split(/[\s,]+/).filter(Boolean).map(Number);
    if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > joined.length)) return null;
    return [...new Set(numbers)].map((n) => joined[n - 1]);
}

const yes = (answer) => !/^n/i.test(answer.trim());

const CLIENTS = { claudeState, installClaude, piState, installPi };

export async function runSetup({ connect = connectAccount, clients = CLIENTS, open = openBrowser } = {}) {
    // Setup is a conversation, so it needs a terminal on the other end. Without
    // one, stdin reaches end of file before the first answer and terminal.question()
    // waits for a line that can never arrive: the process hangs with no output.
    if (!process.stdin.isTTY) {
        console.log('agent-wire setup needs an interactive terminal.');
        console.log('Run it directly in your shell, not through a pipe, a script or an editor task.');
        return 1;
    }

    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    // A terminal can still close mid-answer, on Ctrl-D or a lost session. Race
    // the question against that, or the same silent hang comes back.
    const ask = (question) => Promise.race([
        terminal.question(question),
        new Promise((_, reject) => terminal.once('close', () => reject(new Error('input closed')))),
    ]);

    try {
        console.log('agent-wire setup\n');
        const existing = loadConfig();
        if (existing) console.log(`Found an existing config at ${paths.config} — re-running will update it.\n`);

        // 1. The Slack app, once per team: its Client ID is all a login needs (PKCE, no secret).
        // A later run keeps the app it has; only a first run is asked about it.
        let clientId = existing?.client_id;
        if (clientId) {
            console.log(`Slack app: ${clientId} (to use another one: agent-wire login <client-id>)`);
        } else {
            // Only a typed y skips the steps: showing them to someone who has the app costs a glance,
            // hiding them from someone who has none ends the setup.
            if (!/^y/i.test((await ask('Does your team already have a Slack app for agent-wire? [y/n]: ')).trim())) {
                console.log('\nOne person creates it once for the whole team, in about two minutes.');
                console.log('Slack is opening in your browser with the app filled in: press Next, then Create,');
                console.log('and copy the Client ID from the Basic Information page.');
                console.log(`The steps in full: ${APP_GUIDE}\n`);
                open(createAppUrl());
            }
            clientId = (await ask('Client ID: ')).trim();
            // Someone who expects a bot pastes a token here; it must not be kept or sent anywhere.
            while (/^xox/i.test(clientId)) {
                clientId = (await ask('That is a token, and agent-wire never asks for one. The Client ID is two numbers with a dot, on Basic Information: ')).trim();
            }
            if (!clientId) {
                console.log('No Client ID yet. Run setup again when you have it.');
                return 1;
            }
        }

        // 2. The person's own account, in the browser.
        const connected = await connect({ clientId, teamId: existing?.team_id, team: existing?.team });
        if (!connected.ok) {
            console.log(`\nNot connected: ${connected.reason}.`);
            return 1;
        }
        patchConfig({ ...connected.saved, installed_at: existing?.installed_at ?? new Date().toISOString() });
        console.log(`Connected to ${connected.saved.team} as ${connected.user}.`);
        const client = slackClient(connected.saved.user_token);

        // 3. Which of their channels agent-wire reads and posts in: their choice, nothing implied.
        const joined = await joinedChannels(client);
        if (!joined.ok) {
            console.log(`\nCannot list your channels: ${explain(joined.reason)}`);
            return 1;
        }
        if (joined.channels.length === 0) {
            console.log(`\n${explain('no_channels')}`);
            return 1;
        }
        console.log('\nYour channels:');
        joined.channels.forEach((channel, index) => console.log(`  ${String(index + 1).padStart(2)}. #${channel.name}`));
        const known = new Set((existing?.channels ?? []).map((channel) => channel.id));
        const preset = joined.channels.map((channel, index) => (known.has(channel.id) ? index + 1 : 0)).filter(Boolean);
        const presetShown = preset.length ? ` [${preset.join(',')}]` : '';
        const answer = (await ask(`Channels for agent-wire, by number (1,3)${presetShown}: `)).trim() || preset.join(',');
        const chosen = pickChannels(answer, joined.channels);
        if (!chosen) {
            console.log('No channel chosen. Run setup again — it resumes here.');
            return 1;
        }
        const knownById = new Map((existing?.channels ?? []).map((channel) => [channel.id, channel]));
        // A channel chosen here that is on no list yet may be posted in; one the person has placed
        // (ask, deny) stays where they put it, and the lists are theirs after that.
        const lists = channelLists(existing ?? {});
        const isPlaced = (name) => LISTS.some((list) => lists[list].includes(name));
        const newlyAllowed = chosen.map((channel) => channel.name.toLowerCase()).filter((name) => !isPlaced(name));
        patchConfig({
            channels: chosen.map((channel) => ({ ...knownById.get(channel.id), id: channel.id, name: channel.name })),
            channel_lists: { ...lists, allow: [...lists.allow, ...newlyAllowed] },
        });

        // 4. The agent's name and its signing key.
        const suggested = existing?.nickname ?? defaultNickname();
        // Every other agent drops a message whose name is not one word (protocol.mjs, NICKNAME).
        let nickname = ((await ask(`\nThis agent's name [${suggested}]: `)).trim() || suggested).toLowerCase();
        while (!isNickname(nickname)) {
            nickname = (await ask('One word, at most 32: letters, digits, emoji, _ . or -. This agent\'s name: ')).trim().toLowerCase();
        }
        const keypair = existing?.private_key
            ? { privateKey: existing.private_key, publicKey: existing.public_key }
            : generateKeypair();
        const config = patchConfig({ nickname, private_key: keypair.privateKey, public_key: keypair.publicKey });

        if (chosen.some((channel) => !known.has(channel.id))) {
            const hello = formatMessage({
                from: config.nickname, to: 'all', asPerson: true,
                text: `${config.nickname} joined from ${process.platform}. Key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`,
            });
            for (const channel of chosen.filter((c) => !known.has(c.id))) {
                await client.json('chat.postMessage', { channel: channel.id, text: hello });
            }
        }

        // 5. The clients on this machine, all in one question and none written unasked: these are
        // the person's own client configs, so each change is named before the yes.
        const claude = await clients.claudeState();
        const pi = clients.piState();
        const wants = {
            hook: claude !== 'missing' && hookState() !== 'installed',
            claude: claude === 'absent',
            pi: pi === 'absent' || pi === 'stale',
        };
        const planned = [
            wants.hook && `Claude Code  a hook in ${settingsPath()} that delivers messages before each prompt`,
            wants.claude && 'Claude Code  the agent-wire MCP server (claude mcp add)',
            wants.pi && `pi           the extension ${piExtension()}`,
        ].filter(Boolean);
        if (planned.length > 0) {
            console.log(`\nagent-wire adds itself to the clients found here:\n${planned.map((line) => `  ${line}`).join('\n')}`);
        }
        if (planned.length > 0 && yes(await ask('Add? [Y/n]: '))) {
            if (wants.hook) {
                const written = installHook();
                console.log(written.ok
                    ? `Hook added.${written.backedUp ? ' The previous file is kept as settings.json.agent-wire.bak.' : ''}`
                    : `Hook not added: ${written.reason}`);
            }
            if (wants.claude) {
                const added = await clients.installClaude();
                console.log(added.ok ? 'Registered. Restart Claude Code sessions to load it.' : `Not registered: ${added.reason}`);
            }
            if (wants.pi) {
                const done = clients.installPi();
                console.log(`Extension installed.${done.removedEntry ? ` The agent-wire entry left pi's mcp.json; a copy is at ${done.backup}.` : ''} Run /reload in open pi sessions.`);
            }
        }

        console.log(`\nDone. You are ${config.nickname} in ${channelList(chosen)}, posting as ${connected.user}.`);
        console.log(`Config: ${paths.config}`);
        console.log('Another MCP client: { "mcpServers": { "agent-wire": { "command": "agent-wire", "args": ["serve"] } } }');
        return 0;
    } catch (error) {
        if (error.message !== 'input closed') throw error;

        console.log('\nStopped: no more input. Re-run setup — it resumes where it left off.');
        return 1;
    } finally {
        terminal.close();
    }
}

// The checks setup made, read at a later date: a lapsed login, a channel left, a client that
// lost its hook or its server.
export async function runDoctor({ clients = CLIENTS } = {}) {
    const config = loadConfig();
    if (!config?.user_token) {
        console.log('not logged in — run `agent-wire setup`, or `agent-wire login` if setup ran before');
        return 1;
    }

    // Forced: doctor is what someone runs when something is wrong, and the cached
    // answer is exactly what would be stale in that moment.
    await refreshLatest({ force: true });

    const token = await freshUserToken(config);
    if (!token) {
        console.log(`account    FAILED — the login lapsed (${config.user_refresh_failed ?? 'expired'}): run \`agent-wire login\``);
        return 1;
    }
    const client = slackClient(token);
    const account = await probeToken(client);
    console.log(account.ok ? `account    ok (${account.user} in ${account.team})` : `account    FAILED — ${explain(account.reason)}`);
    if (!account.ok) return 1;

    // A login written, an identity not yet: setup was quit between the two steps.
    if (!config.public_key) {
        console.log('identity   MISSING — setup stopped before naming this agent; run it again');
        return 1;
    }
    console.log(`identity   ${config.nickname}, key ${config.public_key.slice(0, FINGERPRINT_CHARS)}…`);

    const joined = await joinedChannels(client);
    if (!joined.ok) {
        console.log(`channel    FAILED — ${explain(joined.reason)}`);
        return 1;
    }
    const inIt = new Set(joined.channels.map((channel) => channel.id));
    let failed = false;
    for (const channel of config.channels ?? []) {
        const ok = inIt.has(channel.id);
        failed ||= !ok;
        console.log(`channel    #${channel.name} ${ok ? 'ok' : 'FAILED — you are no longer in it'}`);
    }

    const stale = updateNotice();
    if (stale) console.log(`version    OLD — ${stale}`);
    else if (lastCheckFailed()) console.log(`version    ${installedVersion()}, but the registry did not answer: a newer one is not ruled out`);
    else console.log(`version    ${installedVersion()}, the newest published`);

    const claude = await clients.claudeState();
    if (claude !== 'missing') {
        console.log(CLAUDE_REPORT[claude]);
        const delivery = hookState();
        console.log(DELIVERY_REPORT[delivery]);
        if (delivery === 'missing' || delivery === 'broken') {
            console.log(`\nPut this in ${settingsPath()}, or re-run setup:\n${hookSnippet()}`);
            failed = true;
        }
    }
    const pi = clients.piState();
    if (pi !== 'missing') console.log(PI_REPORT[pi]);
    return failed ? 1 : 0;
}
