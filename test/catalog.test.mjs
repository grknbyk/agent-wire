// The tool catalogue is the whole interface an agent sees. Nothing else in this
// package is read by a model on every turn, and a missing annotation or a
// description that contradicts another one is invisible until somebody's agent does
// the wrong thing in a shared channel. So the catalogue is asserted, not reviewed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENT_WIRE_HOME = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));

const { TOOLS, listedFor } = await import('../src/mcp.mjs');

test.after(() => rmSync(process.env.AGENT_WIRE_HOME, { recursive: true, force: true }));

const byName = (name) => TOOLS.find((tool) => tool.name === name);

test('every tool carries all four annotations and a title', () => {
    // Omitting them is not neutral: destructiveHint and openWorldHint default to
    // true, so an unannotated tool asks the user for permission to say a nickname.
    for (const tool of TOOLS) {
        assert.ok(tool.title, `${tool.name} has no title`);
        assert.ok(tool.annotations, `${tool.name} has no annotations`);
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
            assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name}.${hint} is not a boolean`);
        }
    }
});

test('nothing this package does is marked destructive, because nothing is', () => {
    // The log is append-only and Slack keeps every message. A tool here can add to
    // the record or move a marker over it; none of them take anything away.
    for (const tool of TOOLS) {
        assert.equal(tool.annotations.destructiveHint, false, `${tool.name} claims to destroy something`);
    }
});

test('a tool that reaches Slack says so, and one that does not says that', () => {
    for (const name of ['send', 'send_file', 'members', 'inbox']) {
        assert.equal(byName(name).annotations.openWorldHint, true, `${name} reaches Slack but does not admit it`);
    }
    // These read files this machine already has. Claiming an open world makes a
    // client ask before answering a question it could answer offline.
    for (const name of ['my_id', 'status', 'peers', 'channels', 'archive']) {
        assert.equal(byName(name).annotations.openWorldHint, false, `${name} touches nothing remote`);
    }
});

test('inbox is not read-only, whatever its name suggests', () => {
    // Asked for unread, which is the default, it marks what it returns as read. A
    // client that trusted readOnlyHint here would retry it freely and lose messages.
    assert.equal(byName('inbox').annotations.readOnlyHint, false);
});

test('every argument is snake_case, the way the schema publishes it', () => {
    // reply_to, not replyTo. A camelCase alias is simply an unknown argument.
    for (const tool of TOOLS) {
        for (const name of Object.keys(tool.inputSchema?.properties ?? {})) {
            assert.match(name, /^[a-z][a-z0-9_]*$/, `${tool.name}.${name} is not snake_case`);
        }
    }
});

test('a number argument declares its bounds', () => {
    // count: 1e9 was answered with a straight face until these existed, and the
    // check that refuses it reads the bounds from here.
    for (const tool of TOOLS) {
        for (const [name, declared] of Object.entries(tool.inputSchema?.properties ?? {})) {
            if (declared.type !== 'integer') continue;
            assert.equal(typeof declared.minimum, 'number', `${tool.name}.${name} has no minimum`);
            assert.equal(typeof declared.maximum, 'number', `${tool.name}.${name} has no maximum`);
        }
    }
});

test('the pairs a model confuses say which of the two to use', () => {
    // Each of these is a real distinction that the names alone do not carry, so the
    // description has to. Written as mirrors: each one names the other.
    assert.match(byName('peers').description, /members/, 'peers must point at members');
    assert.match(byName('members').description, /peers/, 'members must point at peers');
    assert.match(byName('my_id').description, /status/, 'my_id must point at status');
    assert.match(byName('send_file').description, /\bsend\b/, 'send_file must point at send');
});

test('channels says it cannot change a mode', () => {
    // It is named like a setter and is not one. Modes are prompts, on purpose:
    // nothing a channel message can reach is allowed to silence a channel.
    assert.match(byName('channels').description, /cannot change/i);
});

test('the channel argument lists the configured channels once there are two', () => {
    // A model omitted `channel` with two configured, twice, with the description
    // already telling it not to. A list it can read is worth more than a sentence.
    const two = listedFor({ channels: [{ name: 'wms-agents' }, { name: 'ops' }] });
    const named = two.filter((tool) => tool.inputSchema?.properties?.channel);
    assert.ok(named.length >= 4, 'several tools take a channel and all of them should list it');
    for (const tool of named) {
        assert.deepEqual(tool.inputSchema.properties.channel.enum, ['wms-agents', 'ops'], `${tool.name} does not name the channels`);
        assert.ok(tool.inputSchema.properties.channel.description, `${tool.name} lost its description`);
    }
});

test('one channel is not worth a list, and no config is not a crash', () => {
    // With one configured, omitting the argument is correct, so an enum of one
    // would only add noise. Setup has not run yet the first time a client lists.
    const [alone] = [{ channels: [{ name: 'wms-agents' }] }, undefined, {}, { channels: [] }]
        .map((config) => listedFor(config))
        .filter((tools) => tools !== TOOLS);
    assert.equal(alone, undefined, 'nothing under two channels should rewrite the catalogue');
});

test('tools are listed in a stable order', () => {
    // Clients cache the list and the order feeds prompt caching. Sorting it here
    // would be worse: the order is deliberate, reads before writes.
    const names = TOOLS.map((tool) => tool.name);
    assert.deepEqual(names, [
        'my_id', 'status', 'peers', 'channels', 'members', 'inbox', 'send', 'send_file', 'archive',
    ]);
});
