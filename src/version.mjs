// Nobody chases an install to upgrade it, so the install has to notice. The
// registry is asked at most once every SILENCE_MS, the answer is cached, and the
// asking never blocks anything: a failed check leaves the old answer in place and
// the next one tries again.
import { readFileSync } from 'node:fs';
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
