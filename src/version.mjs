// Nobody chases an install to upgrade it, so the install has to notice. The
// registry is asked at most once every SILENCE_MS, the answer is cached, and the
// asking never blocks anything: a failed check leaves the old answer in place and
// the next one tries again.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { paths, readJson, writeJson } from './config.mjs';

export const PACKAGE_NAME = '@grknbyk/agent-wire';

const SILENCE_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 4000;

const here = dirname(fileURLToPath(import.meta.url));

export const installedVersion = () => JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;

// Semver as this package uses it: three numbers, nothing else. A prerelease or a
// tag answers "not comparable", which reads as "nothing to say" rather than as an
// upgrade nobody asked for.
const parts = (version) => {
    const found = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
    return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
};

export function isNewer(candidate, current) {
    const left = parts(candidate);
    const right = parts(current);
    if (!left || !right) return false;

    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
}

// The published version as of the last successful check, or null while none has
// ever succeeded. Reading never touches the network.
export const knownLatest = () => readJson(paths.update, {}).version ?? null;

// Printing a sentence was not enough, and three releases with an agent stranded on
// each one is the evidence: 0.13.7, 0.14.1 and 0.15.0 all shipped while somebody sat
// on the one before. Nobody reads a notice addressed to nobody, so the install runs
// itself and the notice becomes the fallback rather than the mechanism.
//
// Called from the syncer and nowhere else. That is the one process this machine
// guarantees exactly one of, so two `npm i -g` runs cannot meet in the same global
// directory — which is a thing to prevent, not to find out about afterwards.
const INSTALL_TIMEOUT_MS = 120000;

// npm answers from its own cache and from the tag it already holds: `i -g` came back
// with the previous version three times in one afternoon, on two machines. Clearing
// first and naming the version is the difference, and it is the same line the manual
// `agent-wire update` runs.
// Running `npm` on Windows runs npm.cmd, which means cmd.exe. A hidden cmd.exe
// that installs software, launched by a detached background process nobody is
// watching, is the shape Windows Defender's SuspExec heuristic exists to catch,
// and it blocked exactly that on one machine here. node is a signed binary and
// npm ships as a plain script for it, so calling the script skips the shell:
// no cmd.exe, no && to chain two commands, no window that has to be hidden.
const NPM_CLI = [
    ['node_modules', 'npm', 'bin', 'npm-cli.js'],               // Windows, and nvm
    ['..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'],  // most POSIX installs
];

export const npmScript = () => NPM_CLI
    .map((parts) => join(dirname(process.execPath), ...parts))
    .find((candidate) => existsSync(candidate)) ?? null;

// Resolves either way and never rejects: every caller reads a failed npm as "not
// updated" rather than as an error worth unwinding the stack for.
export const runNpm = (args, { timeout = INSTALL_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    const script = npmScript();
    if (!script) return resolve({ ok: false, out: '', reason: 'no npm-cli.js next to this node' });

    execFile(process.execPath, [script, ...args], { timeout, encoding: 'utf8' }, (error, out) => {
        resolve({ ok: !error, out: String(out ?? '').trim(), reason: error?.message ?? null });
    });
});
export const installArgs = (version) => ['install', '-g', `${PACKAGE_NAME}@${version}`];

export async function selfUpdate() {
    const latest = await refreshLatest();
    if (!isNewer(latest, installedVersion())) return null;

    // It becomes an npm argument next and it arrived over the network. A version
    // is three numbers; anything else is not something to pass on.
    if (!/^\d+\.\d+\.\d+$/.test(latest)) return null;

    // One attempt per published version, or a machine whose npm refuses — no write
    // permission on the global prefix is the usual reason — reinstalls in a loop
    // forever. The next registry check is six hours away and clears this, so a
    // transient failure is retried then, and the printed notice never went away.
    const seen = readJson(paths.update, {});
    if (seen.tried === latest) return null;
    writeJson(paths.update, { ...seen, tried: latest });

    // Two calls rather than one `&&` line, because chaining needs a shell and the
    // shell is the part worth losing. npm answered from its own cache with the
    // previous version three times in one afternoon, so the clean still runs first.
    const cleaned = await runNpm(['cache', 'clean', '--force']);
    if (!cleaned.ok) return null;

    const installed = await runNpm(installArgs(latest));
    return installed.ok ? latest : null;
}

export function updateNotice() {
    const latest = knownLatest();
    const current = installedVersion();
    if (!isNewer(latest, current)) return null;

    return `agent-wire ${latest} is published and this is ${current}. Run \`agent-wire update\`, then restart the MCP server.`;
}

const askedRecently = () => Date.now() - Number(readJson(paths.update, {}).at ?? 0) < SILENCE_MS;

// Resolves either way. A registry that is down, slow or behind a proxy is not a
// reason for a prompt hook to fail or to hang.
export async function refreshLatest({ force = false } = {}) {
    if (!force && askedRecently()) return knownLatest();

    try {
        const answer = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            // The abbreviated-packument type answers 406 on this endpoint.
            headers: { accept: 'application/json' },
        });
        if (!answer.ok) return knownLatest();

        const { version } = await answer.json();
        if (!parts(version)) return knownLatest();

        writeJson(paths.update, { version, at: Date.now() });
        return version;
    } catch {
        // Offline, blocked, or too slow. The cached answer stands and the next
        // check tries again; there is nothing here worth interrupting anyone for.
        return knownLatest();
    }
}
