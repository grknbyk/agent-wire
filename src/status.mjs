// The status: whose account agent-wire speaks for, and what agents may read and write where, in
// the rows of the `agent-wire` screen (owner, 13.11). Plain lines (owner, 05.11); the drawn box it
// replaced showed a mark and a key nobody reads now that posts go out as the person.
// It asks Slack who the token is, because "logged in" is only true if Slack says so.
import { existsSync, statSync } from 'node:fs';

import { channelMode, loadConfig, paths } from './config.mjs';
import { hookState } from './hook.mjs';
import { installedVersion, updateNotice } from './version.mjs';
import { displayWidth } from './protocol.mjs';
import { LISTS, channelLists, dmLists, dmReadLists, dmReadVerdict, verdict } from './policy.mjs';
import { READ_OF, STYLE, heading, isOpen, openFirst, painter, valueCells } from './tui.mjs';

export { displayWidth };

const unit = (count, word) => `${count} ${word}${count === 1 ? '' : 's'} ago`;

function ago(milliseconds) {
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return unit(seconds, 'second');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return unit(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 48) return unit(hours, 'hour');
    return unit(Math.round(hours / 24), 'day');
}

export const lastPoll = () => (existsSync(paths.synced) ? ago(Date.now() - statSync(paths.synced).mtimeMs) : 'never');

// Only what is open: a row with allow or ask on either side. Whatever is on no list, or on deny,
// is refused, and one line says so (owner, 05.11).
// `slack` is what Slack said: { user } once the token answered, { error } when it did not.
// `labels` are the names Slack shows for a channel and a person; without them a row shows what
// the config holds. Read is this session's mode for the channel, which the screen's cell sets
// for every session that chose none.
export function renderStatus(config, { slack = {}, labels = {}, color = false } = {}) {
    const paint = painter(color);
    const account = slack.user
        ? `Slack: ${slack.user}`
        : `Slack: not connected${slack.error ? ` (${slack.error})` : ''} — run \`agent-wire login\``;
    const held = config.channels ?? [];
    const posting = channelLists(config);
    const channelRows = [...new Set([...held.map((channel) => channel.name.toLowerCase()), ...LISTS.flatMap((list) => posting[list])])].map((name) => {
        const channel = held.find((each) => each.name.toLowerCase() === name);
        return { label: labels.channels?.get(name) ?? name, read: channel ? READ_OF[channelMode(config, channel)] : 'deny', write: verdict(posting, name) };
    });
    const messaging = dmLists(config);
    const reading = dmReadLists(config);
    const personRows = [...new Set(LISTS.flatMap((list) => [...messaging[list], ...reading[list]]))]
        .map((handle) => ({ label: labels.people?.get(handle) ?? handle, read: dmReadVerdict(config, handle), write: verdict(messaging, handle) }));
    const block = (what, rows) => {
        const open = rows.filter(isOpen).sort(openFirst);
        return [heading(what, paint), ...(open.length ? open.map((item) => `${valueCells(item, paint)}${paint(STYLE.name, item.label)}`) : ['-'])];
    };
    const lines = [
        `${account} · version ${installedVersion()}`,
        '',
        ...block('Channel', channelRows),
        '',
        ...block('User', personRows),
        '',
        'Everything else is denied.',
    ];

    // A mode is a setting; the prompt hook is what acts on it. A channel on read with nothing
    // delivering looks like it works when it has not said a word.
    const listening = (config.channels ?? []).filter((channel) => channelMode(config, channel) !== 'off');
    const delivery = hookState();
    if (listening.length > 0 && delivery !== 'installed') {
        const gone = delivery === 'broken' ? 'the prompt hook names a file that is gone' : 'no prompt hook';
        lines.push(`nothing is delivering: ${gone}. \`agent-wire doctor\` prints the fix.`);
    }
    const stale = updateNotice();
    if (stale) lines.push(stale);
    return lines.join('\n');
}

// Who the token is, asked of Slack, and the names Slack shows for the rows.
export async function askSlack(config) {
    const { freshUserToken } = await import('./login.mjs');
    const { joinedChannels, listPeople, slackClient } = await import('./slack.mjs');
    const token = await freshUserToken(config);
    if (!token) return { slack: { error: config.user_refresh_failed ?? (config.user_token ? 'login lapsed' : 'no login') } };
    const client = slackClient(token);
    const failed = (error) => ({ ok: false, error: error.message });
    const [who, joined, people] = await Promise.all([client.form('auth.test', {}).catch(failed), joinedChannels(client).catch(failed), listPeople(client).catch(failed)]);
    const labels = {
        channels: new Map((joined.ok ? joined.channels : []).map((channel) => [channel.name.toLowerCase(), `${channel.name} (${channel.private ? 'private' : 'public'})`])),
        people: new Map((people.ok ? people.people : []).map((person) => [person.handle.toLowerCase(), `${person.name} (${person.handle})`])),
    };
    return { slack: who.ok ? { user: who.user } : { error: who.error }, labels };
}

export async function runStatus() {
    const config = loadConfig();
    if (!config) return null;

    console.log(renderStatus(config, { ...await askSlack(config), color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }));
    return 0;
}
