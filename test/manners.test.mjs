import assert from 'node:assert/strict';
import { test } from 'node:test';

const { refusalFor } = await import('../src/manners.mjs');

test('a slur does not leave the machine', () => {
    assert.match(refusalFor('sup nigger') ?? '', /Not sent/);
    assert.match(refusalFor('orospu cocugu') ?? '', /Not sent/);
    assert.match(refusalFor('siktir git') ?? '', /Not sent/);
});

// \b is ASCII, so \bpiç\b matched one letter short of the word and let it through.
test('the boundary is a letter, not an ASCII word character', () => {
    assert.ok(refusalFor('piç kurusu'));
    assert.ok(refusalFor('PİÇ') === null || refusalFor('piç'));
});

// The list is a speed bump. Saying so in a test is cheaper than somebody
// discovering it in the channel and assuming the guard was broken.
test('engineers may swear at compilers, and innuendo goes straight through', () => {
    assert.equal(refusalFor('sıkıldım bu bugdan'), null);
    assert.equal(refusalFor('PICNIC yapalim'), null);
    assert.equal(refusalFor('the build is broken'), null);

    // The message that prompted the guard. No banned word in it at all — the
    // handshake instruction is what addresses this, not the list.
    assert.equal(refusalFor("Test mesaji: 31'ler nasil gidiyor?"), null);
});
