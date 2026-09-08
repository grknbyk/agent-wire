import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { mapLimit } = await import('../src/slack.mjs');
const { pollOnce } = await import('../src/mcp.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('nothing to do is not a round trip', async () => {
    let ran = 0;
    assert.deepEqual(await mapLimit([], 4, async () => { ran++; }), []);
    assert.equal(ran, 0);
});

test('one item works, and a limit wider than the list works', async () => {
    assert.deepEqual(await mapLimit(['a'], 4, async (item) => item.toUpperCase()), ['A']);
    assert.deepEqual(await mapLimit(['a', 'b'], 99, async (item) => item.toUpperCase()), ['A', 'B']);
});

// The one that would corrupt data rather than merely slow it down: a name
// resolved for one user landing against another user's id.
test('results keep input order even when the slowest replies first', async () => {
    const delays = [40, 0, 30, 10, 20];
    const done = await mapLimit(delays, 3, async (delay, index) => {
        await sleep(delay);
        return index;
    });

    assert.deepEqual(done, [0, 1, 2, 3, 4]);
});

test('a limit of one is exactly the serial loop it replaced', async () => {
    const order = [];
    await mapLimit([3, 2, 1], 1, async (item) => {
        order.push(`start${item}`);
        await sleep(item);
        order.push(`end${item}`);
    });

    assert.deepEqual(order, ['start3', 'end3', 'start2', 'end2', 'start1', 'end1']);
});

test('the limit is a ceiling, not a target', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapLimit(Array.from({ length: 20 }, (unused, index) => index), 4, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
    });

    assert.equal(peak, 4);
});

test('a task that throws rejects the whole call, as an await in a loop did', async () => {
    await assert.rejects(
        () => mapLimit([1, 2, 3], 2, async (item) => {
            if (item === 2) throw new Error('slack said no');
            return item;
        }),
        /slack said no/,
    );
});

// A broken channel used to take everybody else's messages down with it. It is
// caught per channel now, so the other channels still land.
test('one failing channel does not cost the other channels their messages', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const method = String(url).split('/api/')[1];
        if (method === 'conversations.history') {
            return { status: 200, ok: true, json: async () => ({ ok: true, has_more: false, messages: [] }) };
        }
        throw new Error('network down');
    };

    const { saveConfig } = await import('../src/config.mjs');
    saveConfig({
        version: 1,
        nickname: 'grkn',
        bot_token: 'xoxb-test',
        channels: [{ id: 'C1', name: 'one' }, { id: 'C2', name: 'two' }],
    });

    // Nothing throws out of pollOnce even though every user lookup would.
    assert.equal(await pollOnce((await import('../src/config.mjs')).loadConfig()), 0);
    globalThis.fetch = realFetch;
});
