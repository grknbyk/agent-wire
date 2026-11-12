// A question an agent sent to a person in a direct message, kept until the person writes back.
// The answer comes hours later, when the session that asked is closed or compacted, so the next
// prompt in the same folder is told that the person wrote (owner, 12.11). It is told the name and
// the agent's own question, never the reply: that is read with the read tool, fenced as data.
import { relative, isAbsolute, resolve } from 'node:path';
import { paths, readJson, updateJson } from './config.mjs';
import { headerSafe } from './protocol.mjs';

export const QUESTION_DAYS = 14;
const QUESTION_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 100;

export const isQuestion = (text) => String(text).includes('?');

const oneLine = (text) => {
    const flat = headerSafe(String(text).replace(/\s+/g, ' ').trim()).replace(/"/g, "'");
    return flat.length > QUESTION_CHARS ? `${flat.slice(0, QUESTION_CHARS - 1)}…` : flat;
};

const isFresh = (record, now) => now - record.asked < QUESTION_DAYS * DAY_MS;

export function noteQuestion({ person, channel, ts, text, folder = process.cwd(), now = Date.now() }) {
    updateJson(paths.questions, [], (records) => [...records, {
        user_id: person.id, handle: person.handle, name: headerSafe(person.name), channel, ts, folder: resolve(folder), asked: now, question: oneLine(text),
    }]);
}

// Run by the syncer. One request per conversation that holds an open question, and none when
// nothing is open. Any message the person sent after the question counts: measured on three real
// conversations (13.11), 61 answers came as plain messages and none in a thread, so the line
// says "wrote", not "answered".
// shortcut: a reply in the thread of the question is counted too, but read does not show thread
// replies of a direct conversation; add them there once somebody answers that way.
export async function checkQuestions(client, now = Date.now()) {
    const records = readJson(paths.questions, []);
    const open = records.filter((record) => isFresh(record, now) && !record.answered);
    const answered = new Set();
    for (const channel of new Set(open.map((record) => record.channel))) {
        const asked = open.filter((record) => record.channel === channel);
        const oldest = asked.map((record) => record.ts).sort((left, right) => Number(left) - Number(right))[0];
        const history = await client.form('conversations.history', { channel, oldest, inclusive: true, limit: HISTORY_LIMIT });
        if (!history.ok) continue;
        for (const record of asked) {
            const wrote = (history.messages ?? []).some((message) => (message.user === record.user_id && Number(message.ts) > Number(record.ts))
                || (message.ts === record.ts && (message.reply_users ?? []).includes(record.user_id)));
            if (wrote) answered.add(record.ts);
        }
    }
    if (answered.size === 0 && records.every((record) => isFresh(record, now))) return 0;
    updateJson(paths.questions, [], (current) => current
        .filter((record) => isFresh(record, now))
        .map((record) => (answered.has(record.ts) ? { ...record, answered: true } : record)));
    return answered.size;
}

// A folder inside the one the question was asked from counts as the same place.
const isWithin = (parent, folder) => {
    const down = relative(parent, resolve(folder));
    return !down.startsWith('..') && !isAbsolute(down);
};

export const answeredIn = (folder = process.cwd(), now = Date.now()) => readJson(paths.questions, [])
    .filter((record) => record.answered && isFresh(record, now) && isWithin(record.folder, folder));

// Reading the conversation with a person closes what they answered, in every folder.
export function settleQuestions(userId) {
    if (!readJson(paths.questions, []).some((record) => record.user_id === userId && record.answered)) return;
    updateJson(paths.questions, [], (records) => records.filter((record) => !(record.user_id === userId && record.answered)));
}
