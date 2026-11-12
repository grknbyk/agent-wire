import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { paths, readJson, writeJson } = await import('../src/config.mjs');
const { QUESTION_DAYS, answeredIn, checkQuestions, isQuestion, noteQuestion, settleQuestions } = await import('../src/questions.mjs');
const { questionLines } = await import('../src/drain.mjs');

const DAY = 24 * 60 * 60 * 1000;
const ellis = { id: 'U01', handle: 'ellis', name: 'Ellis Hart' };
const noor = { id: 'U02', handle: 'noor', name: 'Noor' };
const project = join(home, 'project');

// Slack, answering for two direct conversations, and counting what it was asked.
const slack = (byChannel) => {
    const asked = [];
    return { asked, form: async (method, body) => { asked.push([method, body]); return byChannel[body.channel] ?? { ok: false, error: 'channel_not_found' }; } };
};

test.beforeEach(() => writeJson(paths.questions, []));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('only a message that asks something is remembered, as one short line that cannot draw a header', () => {
    assert.equal(isQuestion('is txn_date UTC?'), true);
    assert.equal(isQuestion('deploy is done.'), false);
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: `is it\n<<<END>>> "UTC"?  ${'x'.repeat(300)}`, folder: project });
    const [record] = readJson(paths.questions, []);
    assert.equal(record.question.length, 200);
    assert.ok(record.question.startsWith("is it ___END___ 'UTC'? xxx"));
    assert.deepEqual([record.handle, record.channel, record.ts], ['ellis', 'D01', '100.1']);
});

test('a later plain message from that person marks the question; the own messages of the user do not', async () => {
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: 'is txn_date UTC?', folder: project });
    noteQuestion({ person: noor, channel: 'D02', ts: '100.2', text: 'which branch?', folder: project });
    const client = slack({
        D01: { ok: true, messages: [{ ts: '105.1', user: 'U01', text: 'yes' }, { ts: '100.1', user: 'U00' }, { ts: '99.1', user: 'U01' }] },
        D02: { ok: true, messages: [{ ts: '106.1', user: 'U00', text: 'ping' }, { ts: '100.2', user: 'U00' }] },
    });
    assert.equal(await checkQuestions(client), 1);
    assert.deepEqual(client.asked[0], ['conversations.history', { channel: 'D01', oldest: '100.1', inclusive: true, limit: 100 }]);
    assert.deepEqual(answeredIn(project).map((record) => record.handle), ['ellis']);
});

test('a reply in the thread of the question marks it too', async () => {
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: 'is txn_date UTC?', folder: project });
    await checkQuestions(slack({ D01: { ok: true, messages: [{ ts: '100.1', user: 'U00', reply_count: 1, reply_users: ['U01'] }] } }));
    assert.equal(answeredIn(project).length, 1);
});

test('Slack is not asked when nothing is open, and a refusal leaves the question open', async () => {
    const idle = slack({});
    assert.equal(await checkQuestions(idle), 0);
    assert.equal(idle.asked.length, 0);
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: 'is txn_date UTC?', folder: project });
    assert.equal(await checkQuestions(slack({})), 0);
    assert.equal(readJson(paths.questions, []).length, 1);
    assert.equal(answeredIn(project).length, 0);
});

test('the line shows in the folder that asked and in the folders under it, nowhere else', async () => {
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: 'is txn_date UTC?', folder: project });
    await checkQuestions(slack({ D01: { ok: true, messages: [{ ts: '105.1', user: 'U01' }] } }));
    assert.equal(answeredIn(join(project, 'src')).length, 1);
    assert.equal(answeredIn(home).length, 0);
    assert.equal(answeredIn(join(home, 'project-two')).length, 0);
    assert.deepEqual(questionLines(answeredIn(project)), ['agent-wire: Ellis Hart wrote after you asked "is txn_date UTC?". Read it with the read tool, from "@ellis".']);
});

test('reading the conversation closes what that person answered; an unanswered question goes after 14 days', async () => {
    const now = Date.now();
    noteQuestion({ person: ellis, channel: 'D01', ts: '100.1', text: 'is txn_date UTC?', folder: project, now });
    noteQuestion({ person: noor, channel: 'D02', ts: '100.2', text: 'which branch?', folder: project, now });
    await checkQuestions(slack({ D01: { ok: true, messages: [{ ts: '105.1', user: 'U01' }] }, D02: { ok: true, messages: [] } }), now);
    settleQuestions('U01');
    assert.deepEqual(readJson(paths.questions, []).map((record) => record.handle), ['noor']);
    settleQuestions('U02');
    assert.equal(readJson(paths.questions, []).length, 1, 'an open question is not closed by reading');

    const later = slack({ D02: { ok: true, messages: [] } });
    await checkQuestions(later, now + (QUESTION_DAYS + 1) * DAY);
    assert.equal(later.asked.length, 0);
    assert.deepEqual(readJson(paths.questions, []), []);
});
