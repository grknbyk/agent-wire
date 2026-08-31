#!/usr/bin/env node
import { activeChannels, loadConfig, setChannelActive } from '../src/config.mjs';
import { pollOnce, serve } from '../src/mcp.mjs';
import { runDoctor, runSetup } from '../src/setup.mjs';
import { markRead, selectMessages } from '../src/inbox.mjs';
import { runStatus } from '../src/status.mjs';

const USAGE = `agent-wire — message other AI coding agents through Slack

  agent-wire status      show identity, channels and unread counts (also the default)
  agent-wire setup       connect a workspace, a channel and this agent's identity
  agent-wire serve       run the MCP stdio server (what your agent client launches)
  agent-wire doctor      re-check the token, the channels and this agent's identity
  agent-wire drain       print messages that arrived since the last drain, then stop
  agent-wire channels    list the channels and whether each one is switched on
  agent-wire on <name>   switch a channel on
  agent-wire off <name>  switch a channel off: not polled, not announced

Docs: https://github.com/grknbyk/agent-wire`;

// For a client hook that runs on every prompt: says a message is waiting without
// spending the agent's turn on reading it, and marks nothing as read.
async function drain() {
    const config = loadConfig();
    if (!config) return 0;

    await pollOnce(config).catch(() => {
        // Offline is not an error here; the next drain catches up.
    });
    const waiting = selectMessages({
        state: 'unread',
        count: 50,
        channels: activeChannels(config).map((channel) => channel.name),
    });
    if (waiting.length === 0) return 0;

    const senders = [...new Set(waiting.map((item) => item.from))].join(', ');
    console.log(`agent-wire: ${waiting.length} unread message(s) from ${senders}.`
        + ' Tell the user in one line. Do not read them unless asked — use the agent-wire inbox tool.');
    return 0;
}

function listChannels() {
    const config = loadConfig();
    const configured = config?.channels ?? [];
    if (configured.length === 0) {
        console.log('no channels configured — run `agent-wire setup`');
        return 1;
    }

    for (const channel of configured) console.log(`${channel.active === false ? 'off' : 'on '}  #${channel.name}`);
    return 0;
}

// Switching a channel is a decision for the person running the agent, so it lives
// on the command line and not in the MCP tool list. A message arriving from the
// channel must not be able to talk the agent into silencing another one.
function switchChannel(name, active) {
    if (!name) {
        console.log(`usage: agent-wire ${active ? 'on' : 'off'} <channel>`);
        return 1;
    }

    const channel = setChannelActive(name, active);
    if (!channel) {
        console.log(`no configured channel named "${name}"`);
        return 1;
    }

    console.log(active
        ? `#${channel.name} is on. The next poll replays everything since it was switched off.`
        : `#${channel.name} is off. It is no longer polled or announced; its history stays readable with inbox channel="${channel.name}".`);
    return 0;
}

const commands = {
    status: () => runStatus() ?? notConfigured(),
    setup: runSetup,
    doctor: runDoctor,
    drain,
    channels: listChannels,
    on: () => switchChannel(process.argv[3], true),
    off: () => switchChannel(process.argv[3], false),
    read: async () => {
        const items = selectMessages({ state: 'unread', count: 50 });
        for (const item of items) console.log(`[${item.authorship}] ${item.at} ${item.from}: ${item.text}`);
        markRead(items);
        return 0;
    },
};

function notConfigured() {
    console.log('not configured yet — run `agent-wire setup`');
    return 1;
}

const name = process.argv[2];

// serve() is the one command that must not exit: the open stdin stream is what
// keeps the MCP server alive, and awaiting a never-resolving promise here would
// make Node print a warning into the very stream the client is parsing.
if (name === 'serve') {
    serve();
} else if (commands[name]) {
    process.exit(await commands[name]() ?? 0);
} else if (!name) {
    // Bare invocation shows where you stand once there is something to stand on,
    // and the usage text while there is not.
    const shown = runStatus();
    if (shown === null) console.log(USAGE);
    process.exit(0);
} else {
    console.log(USAGE);
    process.exit(1);
}
