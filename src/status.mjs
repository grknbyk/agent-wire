// A local status panel. It reads the config and the log and nothing else: no
// network call, so it answers instantly. Whether Slack still accepts the token is
// `doctor`'s question, and duplicating it here would make one of the two slow.
import { existsSync, statSync } from 'node:fs';

import { loadConfig, paths, readJson } from './config.mjs';
import { readInbox, stateOf } from './inbox.mjs';

const INNER_WIDTH = 42;
const LABEL_WIDTH = 6;
const HALF = INNER_WIDTH / 2;
const PEER_CELL = INNER_WIDTH / 3;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// A terminal draws an emoji two columns wide and a box character one, so counting
// characters misaligns any row holding an emoji nickname. Count columns instead.
const WIDE = /^[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const ZERO = /^[̀-ͯ​-‍︀-️]/;

export function displayWidth(text) {
    let columns = 0;
    for (const { segment } of graphemes.segment(String(text))) {
        if (ZERO.test(segment)) continue;
        columns += (WIDE.test(segment) || /\p{Extended_Pictographic}/u.test(segment)) ? 2 : 1;
    }
    return columns;
}

const pad = (text, columns) => text + ' '.repeat(Math.max(0, columns - displayWidth(text)));

// Cut to fit and say so with one character, so a long nickname costs the row one
// column rather than pushing the right border out and ragging the whole panel.
function fit(text, columns) {
    if (displayWidth(text) <= columns) return text;

    let kept = '';
    for (const { segment } of graphemes.segment(String(text))) {
        if (displayWidth(kept + segment) > columns - 1) break;
        kept += segment;
    }
    return `${kept}…`;
}

// A label longer than the column takes the room it needs; the space after it is
// part of the label, so the value never runs into it.
function cell(label, value, columns) {
    const head = pad(`${label} `, LABEL_WIDTH);
    return pad(head + fit(value, columns - displayWidth(head)), columns);
}

// One space of margin on each side, so a row is INNER_WIDTH + 4 columns and lines
// up with the dividers, which span INNER_WIDTH + 2 between their corners.
const row = (text) => `│ ${pad(fit(text, INNER_WIDTH), INNER_WIDTH)} │`;
const pair = (label, value, otherLabel, otherValue) =>
    row(cell(label, value, HALF) + cell(otherLabel, otherValue, HALF));

function divider(title) {
    const label = ` ${title} `;
    const left = Math.floor((INNER_WIDTH + 2 - displayWidth(label)) / 2);
    return `├${'─'.repeat(left)}${label}${'─'.repeat(INNER_WIDTH + 2 - left - displayWidth(label))}┤`;
}

const top = (title) => divider(title).replace('├', '┌').replace('┤', '┐');

function ago(milliseconds) {
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

const lastPoll = () => (existsSync(paths.pollLock) ? ago(Date.now() - statSync(paths.pollLock).mtimeMs) : 'never');

const PEERS_SHOWN = 9; // three full rows of the three-column layout

// Who this agent has actually heard from. The pinned keys say which agents are
// known; the log says when each of them last spoke, and which humans did too.
function correspondents() {
    const seen = new Map();
    for (const item of readInbox()) {
        if (item.authorship === 'self') continue;

        const previous = seen.get(item.from) ?? { name: item.from, everForged: false, at: '' };
        // One forged message stays on the record. A later message that verifies
        // does not undo it, or an attacker could bury the sighting by writing
        // again, which is exactly what an attacker would do.
        previous.everForged = previous.everForged || item.authorship === 'impostor';
        if (item.at >= previous.at) Object.assign(previous, { kind: item.kind, authorship: item.authorship, at: item.at });
        seen.set(item.from, previous);
    }

    // A pinned key whose messages have all been pruned still counts as known.
    for (const [name, peer] of Object.entries(readJson(paths.peers, {}))) {
        if (seen.has(name)) continue;
        seen.set(name, { name, kind: 'agent', authorship: 'signed', at: peer.firstSeen, everForged: false });
    }

    return [...seen.values()].sort((first, second) => second.at.localeCompare(first.at));
}

function unreadByChannel() {
    const states = readJson(paths.states, {});
    const counts = {};
    for (const item of readInbox()) {
        if (stateOf(states, item) !== 'unread') continue;
        counts[item.channel] = (counts[item.channel] ?? 0) + 1;
    }
    return counts;
}

// The panel has room for a symbol, not a word. `*` and `@` are the two marks a
// reader already associates with a machine and a person, and `!` is the one that
// stops the eye. All three are ASCII, so no terminal draws them double-width and
// tips a row over its border.
const peerMark = (peer) => (peer.everForged ? '!' : peer.kind === 'human' ? '@' : '*');

export function renderStatus(config) {
    const counts = unreadByChannel();
    const lines = [
        top('agent-wire'),
        pair('name', config.nickname ?? '(unset)', 'mark', config.mark || '(none)'),
        row(cell('key', config.public_key ?? '', INNER_WIDTH)),
        divider('CHANNELS'),
    ];

    const channels = config.channels ?? [];
    if (channels.length === 0) lines.push(row('none configured'));

    for (const channel of channels) {
        const isOn = channel.active !== false;
        const waiting = counts[channel.name] ?? 0;
        lines.push(row(
            `${pad(fit(channel.name, 12), 13)}${isOn ? '● on ' : '○ off'}`
            + `${String(waiting).padStart(6)} ${isOn ? 'unread' : 'held'}`,
        ));
    }

    const peers = correspondents();
    lines.push(divider('PEERS'));
    if (peers.length === 0) lines.push(row('nobody has written yet'));

    const shown = peers.slice(0, PEERS_SHOWN);
    for (let index = 0; index < shown.length; index += 3) {
        lines.push(row(shown.slice(index, index + 3)
            .map((peer) => pad(`${peerMark(peer)} ${fit(peer.name, PEER_CELL - 3)}`, PEER_CELL))
            .join('')));
    }
    if (peers.length > PEERS_SHOWN) lines.push(row(`and ${peers.length - PEERS_SHOWN} more`));

    lines.push(
        divider('STATE'),
        pair('workspace', config.team ?? config.team_id ?? '(unknown)', 'poll', lastPoll()),
        `└${'─'.repeat(INNER_WIDTH + 2)}┘`,
    );
    // The leading blank line keeps the box off the command that produced it.
    return `\n${lines.join('\n')}`;
}

export function runStatus() {
    const config = loadConfig();
    if (!config) return null;

    console.log(renderStatus(config));
    return 0;
}
