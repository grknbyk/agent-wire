#!/usr/bin/env node
// Only the two cheap modules are imported up front. `status` builds an
// Intl.Segmenter and touches the Extended_Pictographic table, which together cost
// more than everything else this file does; `setup` pulls in readline. A prompt
// hook runs `drain` on every single prompt, so it must not pay for the panel it
// never draws.
import { activeChannels, channelMode, loadConfig, projectScope, scopeId, setChannelMode } from '../src/config.mjs';
import { markRead, selectMessages } from '../src/inbox.mjs';
import { drainReport } from '../src/drain.mjs';
import { mintNonce } from '../src/protocol.mjs';

const USAGE = `agent-wire — message other AI coding agents through Slack

  agent-wire status      show identity, channels and unread counts (also the default)
  agent-wire setup       connect a workspace, a channel and this agent's identity
  agent-wire serve       run the MCP stdio server (what your agent client launches)
  agent-wire doctor      re-check the token, the channels and this agent's identity
  agent-wire drain       report what arrived since the last drain, then stop
  agent-wire channels    list the channels and what each one is set to here
  agent-wire ask <name>  name who is waiting and how many; open nothing (default)
  agent-wire read <name> put the messages themselves into every prompt
  agent-wire off <name>  say nothing about it in this session

The three modes belong to one session, identified by the client's session id when
it publishes one and by the working directory otherwise. The token, the nickname
and the keys are shared. Run a mode command in a plain terminal to set the folder's
default, or set AGENT_WIRE_SCOPE to name a session yourself.

Docs: https://github.com/grknbyk/agent-wire`;

// A prompt hook has one line of the user's screen to work with, so a backlog past
// this is reported as a count rather than listed.
const DRAIN_COUNT = 50;

// For a client hook that runs on every prompt. An `ask` channel costs the agent
// one line and reads nothing; a `read` channel spends the prompt on the messages
// themselves and marks them read, because nothing else is going to.
async function drain() {
    const config = loadConfig();
    if (!config) return 0;

    const { pollOnce } = await import('../src/mcp.mjs');
    await pollOnce(config).catch(() => {
        // Offline is not an error here; the next drain catches up.
    });

    const heard = activeChannels(config);
    const waiting = selectMessages({
        state: 'unread',
        count: DRAIN_COUNT,
        channels: heard.map((channel) => channel.name),
    });
    if (waiting.length === 0) return 0;

    const { lines, readItems } = drainReport(config, heard, waiting, mintNonce());
    if (lines.length === 0) return 0;

    console.log(lines.join('\n'));
    markRead(readItems);
    return 0;
}

function listChannels() {
    const config = loadConfig();
    const configured = config?.channels ?? [];
    if (configured.length === 0) {
        console.log('no channels configured — run `agent-wire setup`');
        return 1;
    }

    for (const channel of configured) console.log(`${channelMode(config, channel).padEnd(4)}  #${channel.name}`);
    console.log(`\nsession ${scopeId()}`);
    if (scopeId() !== projectScope()) console.log(`falls back to ${projectScope()}`);
    return 0;
}

const MODE_EXPLAINED = {
    off: (name) => `#${name} is off for this session. Nothing about it reaches this agent;`
        + ` its history stays readable with inbox channel="${name}".`,
    ask: (name) => `#${name} is on ask. Every prompt names who is waiting and how many, and opens nothing.`,
    read: (name) => `#${name} is on read. Every prompt carries the messages themselves, marked read as they arrive.`
        + ' Other people\'s writing now reaches this agent without you asking for it.',
};

// Which mode a channel is in is a decision for the person running the agent, so
// it lives on the command line and not in the MCP tool list. A message arriving
// from the channel must not be able to talk the agent into silencing another one,
// nor into opening one.
function switchChannel(name, mode) {
    // One channel is the ordinary case, and typing its name adds nothing to the
    // command. Past one there is a real choice, so the names are listed instead.
    const configured = loadConfig()?.channels ?? [];
    const wanted = name ?? (configured.length === 1 ? configured[0].name : null);
    if (!wanted) {
        console.log(configured.length === 0
            ? 'no channels configured — run `agent-wire setup`'
            : `usage: agent-wire ${mode} <channel> — one of ${configured.map((channel) => channel.name).join(', ')}`);
        return 1;
    }

    const changed = setChannelMode(wanted, mode);
    if (!changed) {
        console.log(`no configured channel named "${name}"`);
        return 1;
    }

    console.log(MODE_EXPLAINED[mode](changed.channel.name));
    if (changed.previous === 'off' && mode !== 'off') {
        console.log('The next poll replays everything that arrived while it was off.');
    }
    return 0;
}

const showStatus = async () => (await import('../src/status.mjs')).runStatus();

const commands = {
    status: async () => await showStatus() ?? notConfigured(),
    setup: async () => (await import('../src/setup.mjs')).runSetup(),
    doctor: async () => (await import('../src/setup.mjs')).runDoctor(),
    drain,
    channels: listChannels,
    off: () => switchChannel(process.argv[3], 'off'),
    ask: () => switchChannel(process.argv[3], 'ask'),
    read: () => switchChannel(process.argv[3], 'read'),
    // `on` was the only way to undo `off` before there were three modes, and it
    // meant "announce it without opening it". That is ask.
    on: () => switchChannel(process.argv[3], 'ask'),
};

function notConfigured() {
    console.log('not configured yet — run `agent-wire setup`');
    return 1;
}

const name = process.argv[2];

// The exit code is set, never forced. Calling process.exit() while an undici
// socket from a Slack call is still closing aborts libuv on Windows, and doctor
// hit that on every run. Nothing here holds the event loop open, so letting Node
// finish by itself costs about a millisecond.
//
// serve() is the one command that must not exit at all: the open stdin stream is
// what keeps the MCP server alive.
if (name === 'serve') {
    (await import('../src/mcp.mjs')).serve();
} else if (commands[name]) {
    process.exitCode = await commands[name]() ?? 0;
} else if (!name) {
    // Bare invocation shows where you stand once there is something to stand on,
    // and the usage text while there is not.
    const shown = await showStatus();
    if (shown === null) console.log(USAGE);
} else {
    console.log(USAGE);
    process.exitCode = 1;
}
