import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// slack.mjs reaches config.mjs, which reads HOME once at import time.
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { pollChannel } = await import('../src/slack.mjs');
const { paths } = await import('../src/config.mjs');
const { generateKeypair, signMessage } = await import('../src/identity.mjs');
const { METADATA_EVENT } = await import('../src/protocol.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const channel = { id: 'C1', name: 'team' };
const SINCE = '1000.000000';

// Answers each Slack method from the table and records what was asked. History is
// answered by whether the call names `oldest`: the ordinary read does, the read
// for thread parents does not.
function fakeClient({ history = [], lookback = [], replies = {}, repliesOk = true, fileInfo = { ok: false, error: 'file_not_found' } }) {
    const calls = [];
    const answer = (method, params) => {
        if (method === 'conversations.history') {
            return { ok: true, messages: params.oldest === undefined ? lookback : history, has_more: false };
        }
        if (method === 'conversations.replies') {
            if (!repliesOk) return { ok: false, error: 'ratelimited' };
            // An array is one page; an object holds pages by the cursor that asks for them.
            const answer = replies[params.ts] ?? [];
            if (Array.isArray(answer)) return { ok: true, messages: answer };
            const page = answer[params.cursor ?? ''];
            return { ok: true, messages: page.messages, has_more: Boolean(page.next), response_metadata: { next_cursor: page.next ?? '' } };
        }
        if (method === 'users.info') return { ok: true, user: { profile: { display_name: params.user.toLowerCase() } } };
        if (method === 'files.info') return fileInfo;
        throw new Error(`unexpected Slack method ${method}`);
    };
    return {
        calls,
        token: 'test-token',
        form: async (method, params) => {
            calls.push({ method, params });
            return answer(method, params);
        },
    };
}

const human = (ts, text, extra = {}) => ({ ts, user: 'U1', text, ...extra });
const parent = human('900.000000', 'parent', { reply_count: 2, latest_reply: '1010.000000', thread_ts: '900.000000' });

// One key for every post: the first post pins kai to it, and a second key would
// make every later post an impostor.
const { privateKey, publicKey } = generateKeypair();

function signedPost({ ts, file }) {
    const fields = { channel: channel.id, from: 'kai', to: 'mira', conv: 'c1', hop: 1, file, text: 'here' };
    return {
        ts,
        bot_id: 'B1',
        text: 'here',
        metadata: {
            event_type: METADATA_EVENT,
            event_payload: { ...fields, sig: signMessage(privateKey, fields), key: publicKey, av: 'test' },
        },
    };
}

test('a reply inside a thread reaches the log, and the cursor stays with the channel', async () => {
    const client = fakeClient({
        history: [human('1005.000000', 'top')],
        lookback: [human('1005.000000', 'top'), parent],
        replies: { [parent.ts]: [parent, human('950.000000', 'already seen'), human('1010.000000', 'reply')] },
    });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.deepEqual(result.items.map((item) => item.text), ['top', 'reply']);
    assert.equal(result.newest, '1005.000000', 'a reply must not move the cursor past a top-level message');
    assert.equal(result.newestReply, '1010.000000', 'replies keep a mark of their own');
});

test('a thread longer than one page is read to its end', async () => {
    const client = fakeClient({
        history: [],
        lookback: [parent],
        replies: {
            [parent.ts]: {
                '': { messages: [parent, human('1001.000000', 'first page')], next: 'page2' },
                page2: { messages: [human('1010.000000', 'second page')] },
            },
        },
    });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.deepEqual(result.items.map((item) => item.text), ['first page', 'second page']);
});

test('a thread whose replies are behind the reply mark is not read again', async () => {
    const client = fakeClient({ history: [human('1005.000000', 'top')], lookback: [parent], replies: { [parent.ts]: [parent] } });

    const result = await pollChannel(client, channel, { since: SINCE, repliesSince: '1010.000000', myNickname: 'mira' });

    assert.equal(client.calls.filter((call) => call.method === 'conversations.replies').length, 0);
    assert.equal(result.newestReply, '1010.000000');
});

test('a refused thread read leaves the reply mark where it was', async () => {
    const client = fakeClient({ history: [], lookback: [parent], repliesOk: false });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.equal(result.newestReply, null, 'a null mark is not written, so the next poll asks again');
});

test('a file already on disk is not fetched again', async () => {
    mkdirSync(paths.files, { recursive: true });
    writeFileSync(join(paths.files, 'F3-note.md'), 'kept');
    const client = fakeClient({ history: [signedPost({ ts: '1001.000000', file: 'F3' })] });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.equal(result.items[0].files[0].path, join(paths.files, 'F3-note.md'));
    assert.equal(client.calls.filter((call) => call.method === 'files.info').length, 0);
});

test('a reply also sent to the channel is kept, once', async () => {
    const broadcast = human('1010.000000', 'reply', { subtype: 'thread_broadcast', thread_ts: parent.ts });
    const client = fakeClient({
        history: [broadcast],
        lookback: [broadcast, parent],
        replies: { [parent.ts]: [parent, broadcast] },
    });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.deepEqual(result.items.map((item) => item.text), ['reply']);
});

test('a poll against a deadline reads no threads', async () => {
    const client = fakeClient({ history: [human('1005.000000', 'top')], lookback: [parent] });

    await pollChannel(client, channel, { since: SINCE, myNickname: 'mira', deadline: Date.now() + 60000 });

    assert.equal(client.calls.filter((call) => call.method === 'conversations.replies').length, 0);
    assert.equal(client.calls.filter((call) => call.method === 'conversations.history').length, 1);
});

test('a signed file skipped in a hurry keeps its id on the item', async () => {
    const client = fakeClient({ history: [signedPost({ ts: '1001.000000', file: 'F1' })] });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira', deadline: Date.now() + 60000 });

    assert.equal(result.items[0].fileId, 'F1');
    assert.deepEqual(result.items[0].files, []);
    assert.equal(client.calls.filter((call) => call.method === 'files.info').length, 0, 'a hurried poll fetches no bytes');
});

test('a file whose download failed keeps its id, so the inbox can fetch it later', async () => {
    const client = fakeClient({ history: [signedPost({ ts: '1001.000000', file: 'F2' })] });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.equal(result.items[0].fileId, 'F2');
    assert.deepEqual(result.items[0].files, []);
});

test('a message without a file carries no file id', async () => {
    const client = fakeClient({ history: [signedPost({ ts: '1001.000000', file: '' })] });

    const result = await pollChannel(client, channel, { since: SINCE, myNickname: 'mira' });

    assert.equal('fileId' in result.items[0], false);
});
