// N süreç aynı anda markRead çağırır; states.json içinde kalan anahtar sayısı N*COUNT olmalı.
// Kullanım: node repro/race-states.mjs [agent-wire repo yolu]   (varsayılan: bulunulan klasör)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROCESSES = 4;
const COUNT = 200;

if (process.argv[2] === '--worker') {
    const [, , , repo, id] = process.argv;
    const { markRead } = await import(pathToFileURL(join(repo, 'src/inbox.mjs')).href);
    for (let index = 0; index < COUNT; index++) markRead([{ channel: 'c', ts: `${id}.${index}` }]);
    process.exit(0);
}

const repo = resolve(process.argv[2] ?? '.');
const home = mkdtempSync(join(tmpdir(), 'aw-race-'));
const env = { ...process.env, AGENT_WIRE_HOME: home, AGENT_WIRE_SCOPE: 'race' };

const exitCodes = await Promise.all(Array.from({ length: PROCESSES }, (unused, id) => new Promise((done) =>
    spawn(process.execPath, [process.argv[1], '--worker', repo, String(id)], { env, stdio: 'inherit' })
        .on('exit', done))));

const states = JSON.parse(readFileSync(join(home, 'states.json'), 'utf8'));
rmSync(home, { recursive: true, force: true });

const kept = Object.keys(states).length;
console.log(`beklenen ${PROCESSES * COUNT}, kalan ${kept}${exitCodes.some(Boolean) ? '  (bir worker hata verdi)' : ''}`);
process.exitCode = kept === PROCESSES * COUNT ? 0 : 1;
