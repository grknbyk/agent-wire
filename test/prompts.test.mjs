import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-wire.mjs');
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));

test.after(() => rmSync(home, { recursive: true, force: true }));

// The server is spawned rather than imported because the routing is the thing
// under test: a prompt the client cannot list is a slash command nobody can type.
function serve(requests) {
    return new Promise((done, fail) => {
        const server = spawn(process.execPath, [CLI, 'serve'], { env: { ...process.env, AGENT_WIRE_HOME: home } });
        let output = '';
        server.stdout.on('data', (chunk) => { output += chunk; });
        server.on('error', fail);
        server.on('close', () => done(output.trim().split('\n').map((line) => JSON.parse(line))));

        for (const request of requests) server.stdin.write(`${JSON.stringify(request)}\n`);
        server.stdin.end();
    });
}

// A tool the model can call would let a message arriving from one channel silence
// another. A prompt is offered to the user and invoked by nobody else, which is
// why the modes live here rather than in the tool list.
test('the three modes are offered as prompts, not as tools', async () => {
    const [handshake, listed, tools] = await serve([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'prompts/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ]);

    assert.deepEqual(handshake.result.capabilities, { tools: {}, prompts: {} });
    assert.deepEqual(listed.result.prompts.map((prompt) => prompt.name), ['off', 'ask', 'read', 'status']);
    assert.equal(tools.result.tools.filter((tool) => ['off', 'ask', 'read'].includes(tool.name)).length, 0);
});

test('a prompt carries the command, with and without a channel name', async () => {
    const [named, bare, unknown] = await serve([
        { jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'read', arguments: { channel: 'wms-agents' } } },
        { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'off' } },
        { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'louder' } },
    ]);

    assert.match(named.result.messages[0].content.text, /`agent-wire read wms-agents`/);
    assert.match(bare.result.messages[0].content.text, /`agent-wire off`/);
    assert.equal(unknown.error.code, -32602);
});
