// The permissions as a screen: `agent-wire` alone in a terminal opens it. Two tabs, a search box,
// and one row per channel or person with what agents may read there and what they may write.
// Enter changes the cell under the cursor, and the change is saved at once (owner, 13.11).
//
// It asks for no typed yes, unlike `agent-wire dm allow`: the screen opens only in a terminal,
// which is the part of that question an agent's shell tool cannot pass (owner, 12.11).
import { emitKeypressEvents } from 'node:readline';
import { channelDefault, loadConfig, paths, updateJson } from './config.mjs';
import { LISTS, channelLists, dmLists, dmReadLists, dmReadVerdict, place, removeFrom, verdict } from './policy.mjs';

export const TABS = [
    { key: 'channels', title: 'Channels', what: 'Channel' },
    { key: 'dm', title: 'Direct-Message (DM)', what: 'User' },
];
export const SIDES = ['read', 'write'];

// Enter on a cell: closed, open, open but the user is asked first.
const NEXT = { deny: 'allow', allow: 'ask', ask: 'deny' };
// Reading a channel is its mode (config.mjs), under the three words the screen uses.
const MODE_OF = { allow: 'read', ask: 'ask', deny: 'off' };
export const READ_OF = { read: 'allow', ask: 'ask', off: 'deny' };

const KEYS_LINE = 'Tab switch · ↑↓←→ move · Enter change · type to search · Esc close';
const FIXED_LINES = 7; // title, blank, search, blank, column names, blank, keys
const CELL_WIDTH = 7;
const LABEL_AT = 2 + SIDES.length * CELL_WIDTH;

// The owner's tones (13.11) as the nearest of the 256 colours every terminal has: a muted green
// for allow, a muted orange for ask, greys for the rest. The background is the terminal's own.
export const STYLE = {
    allow: '\x1b[38;5;108m',
    ask: '\x1b[38;5;137m',
    deny: '\x1b[38;5;242m',
    text: '\x1b[38;5;250m',
    name: '\x1b[38;5;246m',
    head: '\x1b[1;38;5;250m',
    keys: '\x1b[38;5;242m',
    cell: '\x1b[48;5;238m',
    tab: '\x1b[1;38;5;250;48;5;236m',
    bold: '\x1b[1m',
    block: '\x1b[7m',
};
const RESET = '\x1b[0m';

export const painter = (color) => (code, text) => (color ? `${code}${text}${RESET}` : text);

export const heading = (what, paint) => `${paint(STYLE.head, 'Read')}   ${paint(STYLE.head, 'Write')}  ${paint(STYLE.head, what)}`;

// The Read and Write cells of one row. `at` is the cell under the cursor: a lighter box, or
// capitals where there is no colour to draw a box with.
export const valueCells = (item, paint, { at = -1, bold = '', color = true } = {}) => SIDES.map((side, index) => {
    const value = item[side];
    const gap = ' '.repeat(CELL_WIDTH - value.length);
    if (index !== at) return paint(bold + STYLE[value], value) + gap;
    return (color ? paint(bold + STYLE.cell + STYLE[value], value) : value.toUpperCase()) + gap;
}).join('');

export const isOpen = (item) => item.read !== 'deny' || item.write !== 'deny';
const rank = (item) => Math.min(LISTS.indexOf(item.read), LISTS.indexOf(item.write));
export const openFirst = (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label);

// What the person set for reading a channel. A session that chose its own mode keeps it.
export const channelRead = (channel) => (channel ? READ_OF[channelDefault(channel)] : 'deny');

const row = (key, label, read, write, source) => ({ key, label, read, write, source });

// Sorted once, by what was open when the screen opened, so a row does not jump away under the
// cursor when a cell changes.
export function openScreen({ config, channels, people }) {
    const posting = channelLists(config);
    const messaging = dmLists(config);
    const known = new Map((config.channels ?? []).map((channel) => [channel.id, channel]));
    return {
        tab: 0,
        col: 0,
        search: '',
        cursor: 0,
        done: false,
        change: null,
        rows: {
            channels: channels
                .map((channel) => row(channel.name.toLowerCase(), `${channel.name} (${channel.private ? 'private' : 'public'})`, channelRead(known.get(channel.id)), verdict(posting, channel.name), channel))
                .sort(openFirst),
            dm: people
                .filter((person) => person.id !== config.user_id)
                .map((person) => row(person.handle.toLowerCase(), `${person.name} (${person.handle})`, dmReadVerdict(config, person.handle), verdict(messaging, person.handle), person))
                .sort(openFirst),
        },
    };
}

// "gokce" finds "Gökçe" and "ilker" finds "İlker": people type names without the marks.
const fold = (text) => String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');

export function visible(state) {
    const words = fold(state.search).split(' ').filter(Boolean);
    return state.rows[TABS[state.tab].key].filter((item) => words.every((word) => fold(item.label).includes(word)));
}

// The cell under the cursor takes its next value. `change` is what the caller writes to the config.
const changeCell = (state) => {
    const target = visible(state)[state.cursor];
    if (!target) return state;
    const tab = TABS[state.tab].key;
    const side = SIDES[state.col];
    const value = NEXT[target[side]];
    return {
        ...state,
        change: { tab, side, value, key: target.key, source: target.source },
        rows: { ...state.rows, [tab]: state.rows[tab].map((item) => (item === target ? { ...item, [side]: value } : item)) },
    };
};

// One key, one new state. `key` is what readline's keypress event gives.
export function press(before, key = {}) {
    const state = { ...before, change: null };
    const last = Math.max(visible(state).length - 1, 0);
    if (key.ctrl && key.name === 'c') return { ...state, done: true };
    if (key.name === 'return' || key.name === 'enter') return changeCell(state);
    if (key.name === 'escape') return state.search ? { ...state, search: '', cursor: 0 } : { ...state, done: true };
    if (key.name === 'tab') return { ...state, tab: (state.tab + 1) % TABS.length, cursor: 0, search: '' };
    if (key.name === 'up') return { ...state, cursor: Math.max(state.cursor - 1, 0) };
    if (key.name === 'down') return { ...state, cursor: Math.min(state.cursor + 1, last) };
    if (key.name === 'left') return { ...state, col: 0 };
    if (key.name === 'right') return { ...state, col: SIDES.length - 1 };
    if (key.name === 'backspace') return { ...state, search: state.search.slice(0, -1), cursor: 0 };
    const typed = key.sequence ?? '';
    if (!key.ctrl && !key.meta && typed.length === 1 && typed >= ' ') return { ...state, search: state.search + typed, cursor: 0 };
    return state;
}

// shortcut: a line is cut by code units, so a name with wide characters can run a column or two
// past the edge; measure cells (protocol.mjs has the segmenter) if a team reports a broken row.
const cut = (text, width) => (text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}…` : text);

// shortcut: the two cells are never cut, so a window under 16 columns wraps its rows; nobody
// works in one, cut them when somebody does.
export function render(state, { rows = 24, columns = 80, color = true } = {}) {
    const paint = painter(color);
    const shown = visible(state);
    const tab = TABS[state.tab];
    const room = Math.max(rows - FIXED_LINES, 1);
    const first = Math.min(Math.max(state.cursor - Math.floor(room / 2), 0), Math.max(shown.length - room, 0));

    // A line too long for the window is cut plain rather than cut through a colour code.
    const fitted = (plain, painted) => (plain.length > columns || !color ? cut(plain, columns) : painted);
    const title = (mark, text) => `${text('Agent-Wire')}  ${TABS.map((each, index) => (index === state.tab ? mark(` ${each.title} `) : text(` ${each.title} `))).join(text('|'))}`;
    const same = (text) => text;
    const search = `Search: ${state.search}`;
    const count = `   ${shown.length}/${state.rows[tab.key].length}`;

    const list = shown.slice(first, first + room).map((item, offset) => {
        const label = cut(item.label, Math.max(columns - LABEL_AT, 0));
        if (first + offset !== state.cursor) return `  ${valueCells(item, paint)}${paint(STYLE.name, label)}`;
        // The cursor row is bold and keeps its colours; the cell under the cursor is the box.
        return `${paint(STYLE.bold + STYLE.text, '›')} ${valueCells(item, paint, { at: state.col, bold: STYLE.bold, color })}${paint(STYLE.bold + STYLE.name, label)}`;
    });

    return [
        fitted(title(same, same), title((text) => paint(STYLE.tab, text), (text) => paint(STYLE.text, text))),
        '',
        fitted(`${search}_${count}`, `${paint(STYLE.text, search)}${paint(STYLE.block, ' ')}${paint(STYLE.text, count)}`),
        '',
        fitted(`  ${heading(tab.what, painter(false))}`, `  ${heading(tab.what, paint)}`),
        ...(list.length ? list : [paint(STYLE.keys, cut('  nothing matches', columns))]),
        ...Array(Math.max(room - Math.max(list.length, 1), 0)).fill(''),
        '',
        paint(STYLE.keys, cut(KEYS_LINE, columns)),
    ];
}

// What one change writes, built on the config as it is at that moment: an entry the screen never
// showed (a person who left Slack) stays where it was.
export function applyChange(config, { tab, side, value, key, source }) {
    const moved = (lists) => (value === 'deny' ? removeFrom(lists, [key]) : place(lists, value, [key]));
    if (tab === 'dm') {
        // Read is written out for this person either way: with no entry of its own it follows the
        // write lists, and would flip together with the Write cell.
        const reading = place(dmReadLists(config), side === 'read' ? value : dmReadVerdict(config, key), [key]);
        return { dm: side === 'write' ? moved(dmLists(config)) : dmLists(config), dm_read: reading, dm_to: undefined };
    }

    // The lists as they stand before a channel is added: a config from before the lists allows
    // every channel it holds, and the new one must not ride in on that.
    const posting = channelLists(config);
    const held = config.channels ?? [];
    const listed = held.some((channel) => channel.id === source.id);
    // A channel setup never picked becomes an agent-wire channel once something on it is opened.
    const channels = listed || value === 'deny' ? held : [...held, { id: source.id, name: source.name }];
    if (side === 'write') return { channels, channel_lists: moved(posting) };
    return { channels: channels.map((channel) => (channel.id === source.id ? { ...channel, mode: MODE_OF[value] } : channel)), channel_lists: posting };
}

async function fromSlack(config) {
    const { freshUserToken } = await import('./login.mjs');
    const { joinedChannels, listPeople, slackClient } = await import('./slack.mjs');
    const token = await freshUserToken(config);
    if (!token) return { ok: false, reason: 'not logged in to Slack: run agent-wire login' };
    const client = slackClient(token);
    const [joined, people] = await Promise.all([joinedChannels(client), listPeople(client)]);
    if (!joined.ok) return { ok: false, reason: `Slack said: ${joined.reason}` };
    if (!people.ok) return { ok: false, reason: `Slack said: ${people.reason}` };
    return { ok: true, channels: joined.channels, people: people.people };
}

// The same screen for a host that draws it itself and sends it the keys (the pi extension): its
// first state, and the write for one change.
export async function loadScreen(load = fromSlack) {
    const config = loadConfig();
    if (!config) return { ok: false, reason: 'agent-wire is not set up: run agent-wire setup' };
    const loaded = await load(config);
    return loaded.ok ? { ok: true, state: openScreen({ config, ...loaded }) } : loaded;
}

export const saveChange = (change) => updateJson(paths.config, { version: 1 }, (current) => ({ ...current, ...applyChange(current, change) }));

const ENTER_SCREEN = '\x1b[?1049h\x1b[?25l';
const LEAVE_SCREEN = '\x1b[?25h\x1b[?1049l';

// Resolves to an exit code, or to null when there is no screen to show (no setup yet, no
// terminal, Slack out of reach) and the caller falls back to the status text.
export async function runScreen({ input = process.stdin, output = process.stdout, load = fromSlack } = {}) {
    if (!input.isTTY || !output.isTTY) return null;
    const config = loadConfig();
    if (!config) return null;
    const loaded = await load(config);
    if (!loaded.ok) {
        output.write(`${loaded.reason}\n\n`);
        return null;
    }

    let state = openScreen({ config, ...loaded });
    const color = !process.env.NO_COLOR;
    const draw = () => output.write(`\x1b[H${render(state, { rows: output.rows, columns: output.columns, color }).map((line) => `${line}\x1b[K`).join('\n')}\x1b[J`);

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(ENTER_SCREEN);
    draw();

    return new Promise((resolve) => {
        const leave = (code, note = '') => {
            input.off('keypress', onKey);
            output.off('resize', draw);
            input.setRawMode(false);
            input.pause();
            output.write(`${LEAVE_SCREEN}${note}`);
            resolve(code);
        };
        function onKey(_text, key) {
            state = press(state, key);
            if (state.change) {
                const { change } = state;
                // A change that cannot be written must not stay on the screen as if it had been.
                try {
                    saveChange(change);
                } catch (error) {
                    return leave(1, `not saved: ${error.message}\n`);
                }
            }
            if (state.done) return leave(0);
            return draw();
        }
        input.on('keypress', onKey);
        output.on('resize', draw);
    });
}
