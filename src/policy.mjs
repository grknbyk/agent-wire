// Who an agent may reach from the person's account, as three lists the person keeps: allow
// (goes), ask (goes once the person says yes in the chat) and deny (never). Anything on no
// list is denied (owner, 05.11). A name on several lists takes the strictest.
export const LISTS = ['allow', 'ask', 'deny'];
const STRICTEST_FIRST = ['deny', 'ask', 'allow'];

const empty = () => ({ allow: [], ask: [], deny: [] });

// The direct-message lists. dm_to was the allow list before there were three.
export function dmLists(config) {
    const lists = { ...empty(), ...(config.dm ?? {}) };
    if (!config.dm && Array.isArray(config.dm_to)) lists.allow = [...config.dm_to];
    return lists;
}

// The channel lists, by channel name. A config from before the lists posted to every channel
// it had, so those start on allow rather than going quiet after an update.
export function channelLists(config) {
    if (config.channel_lists) return { ...empty(), ...config.channel_lists };
    return { ...empty(), allow: (config.channels ?? []).map((channel) => channel.name.toLowerCase()) };
}

// Reading a direct conversation has lists of its own (dm_read) since the screen grew a Read
// column (owner, 13.11). A person on none of them reads as before: open unless writing to them
// is denied, so a config from before the column behaves as it did.
export const dmReadLists = (config) => ({ ...empty(), ...(config.dm_read ?? {}) });

export function dmReadVerdict(config, handle) {
    const wanted = String(handle).toLowerCase();
    const lists = dmReadLists(config);
    if (LISTS.some((list) => lists[list].includes(wanted))) return verdict(lists, wanted);
    return verdict(dmLists(config), wanted) === 'deny' ? 'deny' : 'allow';
}

export function verdict(lists, key) {
    const wanted = String(key).toLowerCase();
    return STRICTEST_FIRST.find((list) => (lists[list] ?? []).includes(wanted)) ?? 'deny';
}

// Moving a name puts it on one list only, so a later "allow" undoes an earlier "deny".
export function place(lists, list, keys) {
    const moved = removeFrom(lists, keys);
    moved[list] = [...new Set([...moved[list], ...keys.map((key) => key.toLowerCase())])];
    return moved;
}

export function removeFrom(lists, keys) {
    const gone = new Set(keys.map((key) => key.toLowerCase()));
    return Object.fromEntries(LISTS.map((list) => [list, (lists[list] ?? []).filter((key) => !gone.has(key))]));
}

// allow and ask let agents reach further, so only a person at a keyboard sets them: a terminal,
// and the word yes typed into it. A pipe or an agent's shell tool has no terminal and is refused
// before anything is asked; deny and remove only narrow, so they need neither (owner, 05.11).
// Not a wall: config.json is still a file the user's account can write.
export const WIDENING = new Set(['allow', 'ask']);

export async function personSaysYes(question, { input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY) return { yes: false, reason: 'no terminal' };
    const { createInterface } = await import('node:readline/promises');
    const terminal = createInterface({ input, output });
    try {
        const answer = await terminal.question(`${question} Type yes to go on: `);
        return answer.trim().toLowerCase() === 'yes' ? { yes: true } : { yes: false, reason: 'not confirmed' };
    } finally {
        terminal.close();
    }
}

export const widenRefusal = (reason) => (reason === 'no terminal'
    ? 'not changed: allow and ask are set by a person typing yes in a terminal, not from a pipe or a tool'
    : 'not changed');

export const showLists = (lists) => LISTS.map((list) => `${list.padEnd(5)} ${lists[list].length ? lists[list].join(', ') : '-'}`).join('\n');
