import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENT_WIRE_HOME = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
const { checkUserToken } = await import('../src/login.mjs');

const config = { team_id: 'T1', team: 'Acme' };
const slack = (answer) => ({ form: async () => answer });

test('a user token of this workspace is accepted, anything else says why', async () => {
    assert.deepEqual(await checkUserToken('xoxp-1', config, slack({ ok: true, team: 'Acme', team_id: 'T1', user_id: 'U1', user: 'juno' })),
        { ok: true, userId: 'U1', user: 'juno', team: 'Acme', teamId: 'T1' });
    assert.match((await checkUserToken('xoxb-1', config, slack({ ok: true }))).reason, /not a user token/);
    assert.match((await checkUserToken('xoxp-1', config, slack({ ok: false, error: 'invalid_auth' }))).reason, /invalid_auth/);
    assert.match((await checkUserToken('xoxp-1', config, slack({ ok: true, team_id: 'T2', team: 'Other' }))).reason, /Other, not to Acme/);
});
