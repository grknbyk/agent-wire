import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENT_WIRE_HOME = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));

const { agreedVersion, refused, textOf, wasRefused, wrongArgument } = await import('../src/mcp.mjs');

test.after(() => rmSync(process.env.AGENT_WIRE_HOME, { recursive: true, force: true }));

const SEND = {
    name: 'send',
    inputSchema: {
        type: 'object',
        properties: {
            to: { type: 'string' },
            text: { type: 'string' },
            count: { type: 'integer', minimum: 1, maximum: 200 },
            state: { type: 'string', enum: ['unread', 'read'] },
        },
        required: ['to', 'text'],
    },
};

test('a version the server knows is answered with itself', () => {
    assert.equal(agreedVersion('2024-11-05'), '2024-11-05');
    assert.equal(agreedVersion('2025-06-18'), '2025-06-18');
    assert.equal(agreedVersion('2025-11-25'), '2025-11-25');
});

test('a version the server does not know is answered with its newest', () => {
    // 2026-07-28 removed initialize altogether, so this server cannot speak it and
    // says so by naming what it can. The client then decides whether to go on.
    assert.equal(agreedVersion('2026-07-28'), '2025-11-25');
    assert.equal(agreedVersion(undefined), '2025-11-25', 'a client that names no version still gets an answer');
    assert.equal(agreedVersion('nonsense'), '2025-11-25');
});

test('arguments that are right are left alone', () => {
    assert.equal(wrongArgument(SEND, { to: 'huso', text: 'hazir' }), null);
    assert.equal(wrongArgument(SEND, { to: 'huso sinan', text: 'hazir', count: 20 }), null);
    assert.equal(wrongArgument(SEND, { to: 'huso', text: 'hazir', state: 'read' }), null);
});

test('a missing required argument is named, not guessed at', () => {
    assert.match(wrongArgument(SEND, { text: 'hazir' }), /to is required/);
    assert.match(wrongArgument(SEND, {}), /to is required/);
});

test('the wrong type says what arrived, with the right article', () => {
    // This one took the server down before the check existed: text reached the
    // signing code as an object and the throw ended the process.
    assert.equal(wrongArgument(SEND, { to: 'huso', text: { a: 1 } }), 'send: text must be a string, got an object');
    assert.equal(wrongArgument(SEND, { to: ['a', 'b'], text: 'hi' }), 'send: to must be a string, got an array');
    assert.equal(wrongArgument(SEND, { to: null, text: 'hi' }), 'send: to must be a string, got null');
    assert.equal(wrongArgument(SEND, { to: 'huso', text: 'hi', count: 1.5 }), 'send: count must be a whole number, got a number');
});

test('numbers outside the declared bounds are refused at both ends', () => {
    assert.match(wrongArgument(SEND, { to: 'a', text: 'b', count: -5 }), /at least 1/);
    assert.match(wrongArgument(SEND, { to: 'a', text: 'b', count: 0 }), /at least 1/);
    assert.match(wrongArgument(SEND, { to: 'a', text: 'b', count: 1e9 }), /at most 200/);
});

test('an enum says which words it accepts', () => {
    assert.match(wrongArgument(SEND, { to: 'a', text: 'b', state: 'archived' }), /must be one of unread, read/);
});

test('an argument the schema never declared is ignored, not refused', () => {
    // A model inventing a field should not cost the user the message it wrote.
    assert.equal(wrongArgument(SEND, { to: 'huso', text: 'hazir', urgency: 'high' }), null);
});

test('a refusal is distinguishable from an answer without reading the English', () => {
    // The whole point. "Slack rejected it (channel_not_found)" and "delivered to
    // huso" used to be the same shape, so nothing but the prose told them apart.
    const no = refused('Slack rejected it (channel_not_found)');
    assert.equal(wasRefused(no), true);
    assert.equal(textOf(no), 'Slack rejected it (channel_not_found)');

    const yes = 'delivered to huso in #wms-agents as wms-agents@k7m2pq';
    assert.equal(wasRefused(yes), false);
    assert.equal(textOf(yes), yes);
});

test('an empty result is not a failure', () => {
    // "no unread messages" is the inbox doing its job on a quiet channel. Marking it
    // isError would have every idle prompt reporting a broken tool.
    assert.equal(wasRefused('no unread messages'), false);
    assert.equal(wasRefused('no agents seen yet'), false);
});
