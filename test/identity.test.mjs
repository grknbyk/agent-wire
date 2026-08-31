import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The pin store lives under AGENT_WIRE_HOME, so the tests get their own throwaway
// one. It has to be set before config.mjs is imported, since HOME is read once.
const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { checkAuthorship, generateKeypair, signMessage } = await import('../src/identity.mjs');

const fields = { channel: 'C123', to: 'mira', conv: 'abc123', hop: 1, text: 'the migration is ready' };

const signedBy = (keypair, from, overrides = {}) => ({
    from,
    publicKey: keypair.publicKey,
    signature: signMessage(keypair.privateKey, { from, ...fields, ...overrides }),
    ...fields,
    ...overrides,
});

test.after(() => rmSync(home, { recursive: true, force: true }));

test('a first message pins the key to the name', () => {
    const grkn = generateKeypair();
    assert.equal(checkAuthorship(signedBy(grkn, 'grkn')).verdict, 'new');
    assert.equal(checkAuthorship(signedBy(grkn, 'grkn')).verdict, 'signed');
});

test('a different key claiming a pinned name is reported as an impostor', () => {
    const real = generateKeypair();
    const forger = generateKeypair();
    checkAuthorship(signedBy(real, 'mira'));

    assert.equal(checkAuthorship(signedBy(forger, 'mira')).verdict, 'impostor');
});

test('a message with no signature is unsigned, whatever the header claims', () => {
    assert.equal(checkAuthorship({ from: 'nox', ...fields }).verdict, 'unsigned');
});

test('changing the text after signing breaks the signature', () => {
    const nox = generateKeypair();
    const message = signedBy(nox, 'nox');
    message.text = 'the migration is NOT ready';

    assert.equal(checkAuthorship(message).verdict, 'unsigned');
});

test('a signature cannot be replayed into another channel', () => {
    const hakan = generateKeypair();
    const message = signedBy(hakan, 'hakan');
    message.channel = 'C999';

    assert.equal(checkAuthorship(message).verdict, 'unsigned');
});

test('a malformed key is a failed check, not a crash', () => {
    assert.equal(checkAuthorship({ from: 'x', publicKey: 'not-base64-der', signature: 'nope', ...fields }).verdict, 'unsigned');
});

test('a signature over one file does not verify for another', () => {
    const mira = generateKeypair();
    checkAuthorship(signedBy(mira, 'mira', { file: 'F0PLAN' }));

    const swapped = { ...signedBy(mira, 'mira', { file: 'F0PLAN' }), file: 'F0MALWARE' };
    assert.equal(checkAuthorship(swapped).verdict, 'unsigned');
});

test('a message with no file still verifies', () => {
    const nox = generateKeypair();
    assert.equal(checkAuthorship(signedBy(nox, 'nox')).verdict, 'new');
});
