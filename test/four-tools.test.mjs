import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;
process.env.AGENT_WIRE_SCOPE = 'session-under-test';

const { saveConfig } = await import('../src/config.mjs');
const { TOOLS, call, routed, textOf, wasRefused } = await import('../src/mcp.mjs');

// "ellis" is an agent and a person at once; "mira" is only an agent.
const fits = (name) => ({ agent: ['ellis', 'mira'].includes(name), human: name === 'ellis' });

test.before(() => saveConfig({
    version: 1, nickname: 'juno', mark: '', public_key: 'MCowBQYDK2VwAyEAtestkeytestkeytestkey', channels: [{ id: 'C01', name: 'dev-agents' }],
}));
test.after(() => rmSync(home, { recursive: true, force: true }));

test('read, write, who and status are listed, ahead of the thirteen older names', () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.deepEqual(names.slice(0, 3), ['read', 'write', 'who']);
    assert.ok(names.includes('status'));
    assert.equal(names.length, 16);
});

test('read goes to the channel log, to one channel, or to one direct conversation', () => {
    assert.deepEqual(routed('read', {}), { name: 'inbox', args: {} });
    assert.deepEqual(routed('read', { state: 'all', before: '10.1' }), { name: 'inbox', args: { state: 'all', before: '10.1' } });
    assert.deepEqual(routed('read', { from: '#ops', count: 3 }), { name: 'inbox', args: { channel: 'ops', count: 3 } });
    assert.deepEqual(routed('read', { from: '@ellis', before: '10.1' }), { name: 'dm_read', args: { to: 'ellis', before: '10.1' } });
    assert.match(routed('read', { from: 'ellis' }).refusal, /"@ellis".*"#ellis"/);
});

test('write sends a bare name to the agent, #name to the channel and @name to the person', () => {
    assert.deepEqual(routed('write', { to: 'mira juno', text: 'hi' }, fits), { name: 'send', args: { to: 'mira juno', text: 'hi' } });
    assert.deepEqual(routed('write', { to: '#ops', text: 'hi', confirm: true }, fits), { name: 'send', args: { to: 'all', channel: 'ops', confirm: true, text: 'hi' } });
    assert.deepEqual(routed('write', { to: '@ellis', text: 'hi', path: 'a.md' }, fits), { name: 'dm', args: { to: 'ellis', text: 'hi', path: 'a.md' } });
    assert.deepEqual(routed('write', { to: 'mira', path: 'a.md', text: 'the plan', reply_to: '9.1' }, fits), { name: 'send_file', args: { to: 'mira', reply_to: '9.1', path: 'a.md', note: 'the plan' } });
});

test('a name that is both an agent and a person is refused with both ways to say it', () => {
    const refusal = routed('write', { to: 'ellis', text: 'is txn_date UTC?' }, fits).refusal;
    assert.match(refusal, /"@ellis" for a direct message/);
    assert.match(refusal, /pass channel/);
    assert.equal(routed('write', { to: 'ellis', text: 'hi', channel: 'dev-agents' }, fits).name, 'send');
    assert.equal(routed('write', { to: '@ellis', text: 'hi' }, fits).name, 'dm');
});

test('write refuses a mixed target, an empty message and a direct message that is only a file', () => {
    assert.match(routed('write', { to: '@ellis mira', text: 'hi' }, fits).refusal, /one "@person"/);
    assert.match(routed('write', { to: '#ops #dev', text: 'hi' }, fits).refusal, /one "#channel"/);
    assert.match(routed('write', { to: 'mira' }, fits).refusal, /needs text/);
    assert.match(routed('write', { to: '@ellis', path: 'a.md' }, fits).refusal, /needs text beside the file/);
});

test('who alone answers from this machine; with a filter or a channel it asks Slack through the older tools', async () => {
    assert.deepEqual(routed('who', { filter: 'ell' }), { name: 'people', args: { filter: 'ell' } });
    assert.deepEqual(routed('who', { channel: 'ops' }), { name: 'members', args: { channel: 'ops' } });
    const answer = await call('who', {}, { nonce: 'n' });
    assert.equal(wasRefused(answer), false);
    assert.match(textOf(answer), /juno/);
    assert.match(textOf(answer), /#dev-agents/);
    assert.match(textOf(answer), /agents seen:/);
});

test('a refusal from the routing reaches the caller before anything is sent', async () => {
    const answer = await call('read', { from: 'ellis' }, { nonce: 'n' });
    assert.equal(wasRefused(answer), true);
    const empty = await call('write', { to: 'mira' }, { nonce: 'n' });
    assert.match(textOf(empty), /needs text/);
});
