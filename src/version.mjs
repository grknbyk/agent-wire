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

// Installing is the person's step: `agent-wire update` runs it, and drain prints a notice while
// a newer version waits. The syncer used to install on its own; the owner turned that off (05.11).
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

export function updateNotice() {
    const latest = knownLatest();
    const current = installedVersion();
    if (!isNewer(latest, current)) return null;

    return `agent-wire ${latest} is published and this is ${current}. Run \`agent-wire update\`, then restart the MCP server.`;
}

const askedRecently = () => Date.now() - Number(readJson(paths.update, {}).at ?? 0) < SILENCE_MS;

// Whether the last check got no usable answer: the registry down, slow or behind a proxy, an error
// status, or an answer that is no version. The version known from before stands in knownLatest, but
// it says nothing about now, so a caller that wants to call this install the newest asks here first.
export const lastCheckFailed = () => readJson(paths.update, {}).failed === true;

// Resolves either way. A registry that is down, slow or behind a proxy is not a
// reason for a prompt hook to fail or to hang; lastCheckFailed tells the two outcomes apart.
export async function refreshLatest({ force = false } = {}) {
    if (!force && askedRecently()) return knownLatest();

    // A failed check is remembered like a good one. Unrecorded, a registry that hangs (a proxy,
    // a closed network) cost every prompt the whole timeout: drain took 4.1 s instead of 0.1 s
    // (measured 05.11). The version already known stands until the next check.
    const gaveUp = () => {
        writeJson(paths.update, { version: knownLatest(), at: Date.now(), failed: true });
        return knownLatest();
    };

    try {
        const answer = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            // The abbreviated-packument type answers 406 on this endpoint.
            headers: { accept: 'application/json' },
        });
        if (!answer.ok) return gaveUp();

        const { version } = await answer.json();
        if (!parts(version)) return gaveUp();

        writeJson(paths.update, { version, at: Date.now() });
        return version;
    } catch {
        // Offline, blocked, or too slow. The cached answer stands and the next
        // check, hours later, tries again; there is nothing here worth interrupting anyone for.
        return gaveUp();
    }
}
