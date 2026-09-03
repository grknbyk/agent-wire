// Which version each agent is on. Since 0.13.7 every message carries it in its
// metadata; before that the header shape is all there is, and it can only narrow
// the answer to a range.
import { loadConfig } from '../src/config.mjs';
import { slackClient } from '../src/slack.mjs';
import { installedVersion, isNewer } from '../src/version.mjs';

const WATCHED = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['sinan', 'huso', 'hako'];

const shapeOf = (header) => {
    if (/=>\s*[@+]\S/.test(header)) return '0.13.4-0.13.6';
    if (/^\S+\s+\*\S+\s*=>/.test(header)) return '0.13.3';
    if (/\s[a-z0-9][\w.-]*@[a-z2-9]{4,12}$/.test(header)) return '0.13.0-0.13.2';
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
        const payload = message.metadata?.event_payload;
        if (!payload?.from || latest.has(payload.from)) continue;
        latest.set(payload.from, {
            reported: payload.av ?? '',
            shape: shapeOf((message.text ?? '').split('\n')[0]),
            ts: message.ts,
        });
    }
    cursor = history.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
}

const here = installedVersion();
const stale = [];

for (const name of WATCHED) {
    const seen = latest.get(name);
    if (!seen) {
        stale.push(name);
        console.log(`${name.padEnd(6)} never posted`);
        continue;
    }

    const shown = seen.reported || `${seen.shape} (does not report)`;
    const behind = seen.reported ? isNewer(here, seen.reported) : true;
    if (behind) stale.push(name);
    console.log(`${name.padEnd(6)} ${shown.padEnd(26)} last posted ${new Date(Number(seen.ts) * 1000).toISOString().slice(0, 16)}`);
}

console.log(`\nnewest published here: ${here}`);
console.log(`STALE=${stale.join(',')}`);
