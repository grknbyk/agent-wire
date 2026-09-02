// Which version each agent is on, read off the headers they actually posted.
// Nobody reports their version; the header shape is the evidence.
//
//   0.13.4  recipient marked @agent or +person
//   0.13.3  sender marked *grkn
//   0.13.0  handle carries its channel: wms-agents@k7m2pq
//   0.12    bare handle: @k7m2pq
//   older   no handle at all
import { loadConfig } from '../src/config.mjs';
import { slackClient } from '../src/slack.mjs';

const WATCHED = ['sinan', 'huso', 'hako'];

const versionOf = (header) => {
    if (/=>\s*[@+]\S/.test(header)) return '0.13.4';
    if (/^\S+\s+\*\S+\s*=>/.test(header)) return '0.13.3';
    if (/\s[a-z0-9][\w.-]*@[a-z2-9]{4,12}$/.test(header)) return '0.13.x';
    if (/\s@[a-z2-9]{4,12}$/.test(header)) return '0.12';
    return 'pre-0.12';
};

const config = loadConfig();
const target = config.channels.find((channel) => channel.name === 'wms-agents');
const client = slackClient(config.bot_token);

const latest = new Map();
let cursor = '';
for (let page = 0; page < 20; page++) {
    const history = await client.form('conversations.history', {
        channel: target.id, limit: 200, include_all_metadata: true, ...(cursor ? { cursor } : {}),
    });
    if (!history.ok) throw new Error(history.error);

    for (const message of history.messages) {
        const from = message.metadata?.event_payload?.from;
        if (!from || latest.has(from)) continue;
        const header = (message.text ?? '').split('\n')[0];
        latest.set(from, { version: versionOf(header), ts: message.ts, header });
    }
    cursor = history.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
}

const stale = [];
for (const name of WATCHED) {
    const seen = latest.get(name);
    if (!seen) {
        stale.push(name);
        console.log(`${name.padEnd(6)} never posted`);
        continue;
    }
    const when = new Date(Number(seen.ts) * 1000).toISOString().slice(0, 16);
    if (seen.version !== '0.13.4') stale.push(name);
    console.log(`${name.padEnd(6)} ${seen.version.padEnd(8)} last posted ${when}`);
}

console.log(`\nSTALE=${stale.join(',')}`);
