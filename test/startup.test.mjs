import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SRC = new URL('../src/', import.meta.url);
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));

// What a fresh process holds after importing one module, asked of that process itself.
const loadsHttp = (file) => {
    const script = `await import(${JSON.stringify(new URL(file, SRC).href)}); console.log(process.moduleLoadList.includes('NativeModule http'));`;
    const answer = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, AGENT_WIRE_HOME: home }, encoding: 'utf8' });
    return answer.trim() === 'true';
};

// drain runs before every prompt (through sync.mjs) and an MCP server starts with every session
// (mcp.mjs): node:http costs about 17 ms to load and only a login listens on a port.
test('what drain and the MCP server load does not load node:http', () => {
    for (const file of ['sync.mjs', 'mcp.mjs', 'status.mjs', 'setup.mjs']) {
        assert.equal(loadsHttp(file), false, `${file} loads node:http at import`);
    }
});
