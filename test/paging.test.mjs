import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;
process.env.AGENT_WIRE_SCOPE = 'session-under-test';

const { saveConfig } = await import('../src/config.mjs');
const { DEFAULT_COUNT, appendMessages, markRead, selectPage } = await import('../src/inbox.mjs');
const { readDirect } = await import('../src/slack.mjs');
const { pageNote } = await import('../src/mcp.mjs');

const message = (channel, ts) => ({ ts, at: '2026-08-31T00:00:00Z', channel, from: 'mira', kind: 'agent', authorship: 'signed', text: `m${ts}` });

// Arrival order, not ts order: a poll of one channel lands after a poll of the other.
const ARRIVED = ['100.1', '101.1', '90.1', '91.1', '102.1', '103.1', '92.1', '104.1', '105.1', '93.1', '106.1', '107.1'];

test.before(() => {
    saveConfig({ version: 1, nickname: 'juno', channels: [{ id: 'C01', name: 'dev' }, { id: 'C02', name: 'ops' }] });
    appendMessages(ARRIVED.map((ts) => message(Number(ts) < 100 ? 'ops' : 'dev', ts)));
});
test.after(() => rmSync(home, { recursive: true, force: true }));

test('going back five at a time reads every message once, also the ones that arrived out of order', () => {
    assert.equal(DEFAULT_COUNT, 5);
    const pages = [];
    let before = null;
    for (;;) {
        const page = selectPage({ state: 'all', before });
        pages.push(page.items.map((item) => item.ts));
        if (!page.older) break;
        before = page.items[0].ts;
    }
    assert.deepEqual(pages.map((page) => page.length), [5, 5, 2]);
    assert.deepEqual(pages.reverse().flat(), ARRIVED);
});

test('a page of one channel steps over the other channel and still says whether more is left', () => {
    const first = selectPage({ state: 'all', channel: 'ops', count: 3 });
    assert.deepEqual(first.items.map((item) => item.ts), ['91.1', '92.1', '93.1']);
    assert.equal(first.older, true);
    const second = selectPage({ state: 'all', channel: 'ops', count: 3, before: first.items[0].ts });
    assert.deepEqual([second.items.map((item) => item.ts), second.older], [['90.1'], false]);
});

test('unread pages go back by themselves: what a page showed is read, the next call gets the ones before', () => {
    const newest = selectPage({ channel: 'dev', count: 5 });
    markRead(newest.items);
    const next = selectPage({ channel: 'dev', count: 5 });
    assert.deepEqual(next.items.map((item) => item.ts), ['100.1', '101.1', '102.1']);
    assert.equal(next.older, false);
});

test('the last line of a page names the value that reads the page before it', () => {
    const page = [{ ts: '103.1' }, { ts: '104.1' }];
    assert.equal(pageNote(page, true), '-- 2 messages, none skipped between them. Older ones exist: the same call with before="103.1" reads the ones before these.');
    assert.equal(pageNote([page[0]], false, ' that is unread'), '-- 1 message, none skipped between them. Nothing older that is unread.');
});

test('a direct conversation is read back from a message: Slack gets it as latest and says whether more is left', async () => {
    const asked = [];
    const client = {
        form: async (method, body) => {
            asked.push([method, body]);
            if (method === 'conversations.open') return { ok: true, channel: { id: 'D01' } };
            return { ok: true, has_more: true, messages: [{ ts: '9.2', text: 'newer' }, { ts: '9.1', text: 'older' }] };
        },
    };
    const page = await readDirect(client, 'U01', 5, '10.0');
    assert.deepEqual(asked[1], ['conversations.history', { channel: 'D01', limit: 5, latest: '10.0' }]);
    assert.deepEqual([page.messages.map((m) => m.ts), page.older], [['9.1', '9.2'], true]);
    await readDirect(client, 'U01', 5);
    assert.equal('latest' in asked[3][1], false);
});
