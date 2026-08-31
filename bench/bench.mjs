// Not shipped: package.json lists only bin, src, assets and the manifest. This is
// here so a change that makes agent-wire slower shows up as a number rather than
// as a report from somebody whose channel got busy.
//
// Run: node bench/bench.mjs [--json] [--baseline bench/baseline.json]
//
// Every metric is a median of REPEATS runs, because one run on a laptop measures
// the laptop. The synthetic log is deliberately larger than a real one: a bridge
// that stays quick at 20k messages is quick at 300.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_SIZE = 20000;
const MEMBER_COUNT = 200;
const POLL_MESSAGES = 500;
const VERIFY_MESSAGES = 200;
const REPEATS = 7;

const home = mkdtempSync(join(tmpdir(), 'agent-wire-bench-'));
process.env.AGENT_WIRE_HOME = home;

const { paths, writeJson } = await import('../src/config.mjs');
const inbox = await import('../src/inbox.mjs');
const identity = await import('../src/identity.mjs');
const protocol = await import('../src/protocol.mjs');
const slack = await import('../src/slack.mjs');

const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];

// Warm once, then measure. The first call through a code path pays for parsing and
// for the JIT, and reporting that number as the steady state is how a benchmark
// starts lying.
function timeIt(run) {
    run();
    const samples = [];
    for (let attempt = 0; attempt < REPEATS; attempt++) {
        const started = process.hrtime.bigint();
        run();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return median(samples);
}

async function timeAsync(run) {
    await run();
    const samples = [];
    for (let attempt = 0; attempt < REPEATS; attempt++) {
        const started = process.hrtime.bigint();
        await run();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return median(samples);
}

// --- fixtures

const channelNames = ['agent-wire', 'agent-wms', 'agent-crm'];

function writeSyntheticLog() {
    const lines = [];
    const states = {};
    for (let index = 0; index < LOG_SIZE; index++) {
        const channel = channelNames[index % channelNames.length];
        const ts = `${1700000000 + index}.000100`;
        lines.push(JSON.stringify({
            ts,
            at: new Date(1700000000000 + index * 1000).toISOString(),
            channel,
            channelId: `C${index % 3}`,
            from: `agent${index % 7}`,
            to: 'all',
            kind: 'agent',
            authorship: 'signed',
            conv: `conv${index % 500}`,
            hop: (index % 8) + 1,
            text: `message ${index} — ${'body '.repeat(12)}`,
            files: [],
        }));
        // Most of a real log is already read; the unread tail is what a session asks for.
        if (index < LOG_SIZE - 200) states[`${channel}:${ts}`] = 'read';
    }
    writeFileSync(paths.inbox, lines.join('\n') + '\n');
    writeJson(paths.states, states);
}

// A client that answers from memory. The point is the code around the call, not
// Slack's latency, which no change in this repo can move.
function stubClient() {
    const members = Array.from({ length: MEMBER_COUNT }, (unused, index) => `U${index}`);
    const messages = Array.from({ length: POLL_MESSAGES }, (unused, index) => ({
        ts: `${1800000000 + index}.000200`,
        user: `U${index % MEMBER_COUNT}`,
        text: `human line ${index}`,
    }));

    return {
        token: 'xoxb-bench',
        form: async (method) => {
            if (method === 'conversations.members') return { ok: true, members };
            if (method === 'users.info') return { ok: true, user: { real_name: 'Bench Person' } };
            if (method === 'conversations.history') return { ok: true, messages, has_more: false };
            return { ok: false, error: 'unexpected_method' };
        },
        json: async () => ({ ok: true, ts: '1.1' }),
    };
}

// --- metrics

async function measure() {
    writeSyntheticLog();

    const keypair = identity.generateKeypair();
    const signedFields = { channel: 'C1', to: 'mira', conv: 'abc', hop: 1, file: '', text: 'a plan worth reading' };
    const signature = identity.signMessage(keypair.privateKey, { from: 'grkn', ...signedFields });
    const nonce = protocol.mintNonce();
    const envelopeItem = {
        from: 'mira', kind: 'agent', authorship: 'signed', channel: 'agent-wire', ts: '1.2', hop: 1,
        text: 'the migration is ready',
        files: [{ name: 'plan.md', path: join(home, 'files', 'F1-plan.md'), size: 10 }],
    };
    const client = stubClient();
    const channel = { id: 'C1', name: 'agent-wire' };

    const results = {
        read_inbox_ms: timeIt(() => inbox.readInbox()),
        select_unread_ms: timeIt(() => inbox.selectMessages({ state: 'unread', count: 20 })),
        select_by_channel_ms: timeIt(() => inbox.selectMessages({ state: 'all', count: 50, channel: 'agent-wms' })),
        append_dedup_ms: timeIt(() => inbox.appendMessages([{ channel: 'agent-wire', ts: '1700000001.000100', text: 'dup' }])),
        find_by_ts_ms: timeIt(() => inbox.findByTs('1700019999.000100')),
        verify_authorship_ms: timeIt(() => {
            for (let attempt = 0; attempt < VERIFY_MESSAGES; attempt++) {
                identity.checkAuthorship({ from: 'grkn', publicKey: keypair.publicKey, signature, ...signedFields });
            }
        }),
        render_envelope_ms: timeIt(() => {
            for (let attempt = 0; attempt < VERIFY_MESSAGES; attempt++) protocol.renderEnvelope(nonce, envelopeItem);
        }),
        list_members_ms: await timeAsync(() => slack.listMembers(client, 'C1')),
        poll_channel_ms: await timeAsync(() => slack.pollChannel(client, channel, { since: null, myNickname: 'grkn' })),
        cold_help_ms: coldStart('help'),
        cold_status_ms: coldStart('status'),
        rss_peak_mb: Math.round(process.memoryUsage().rss / 1048576),
    };
    return results;
}

// What `agent-wire drain` pays on every single prompt, so it is the one number a
// user feels directly.
function coldStart(command) {
    const samples = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const started = process.hrtime.bigint();
        // Both commands can exit non-zero by design, so the status is not checked.
        spawnSync(process.execPath, [join(ROOT, 'bin', 'agent-wire.mjs'), command], { stdio: 'ignore' });
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    return median(samples);
}

// --- report

const WORK_METRICS = [
    'read_inbox_ms', 'select_unread_ms', 'select_by_channel_ms', 'append_dedup_ms', 'find_by_ts_ms',
    'verify_authorship_ms', 'render_envelope_ms', 'list_members_ms', 'poll_channel_ms',
];

// One number for the learning-rate loop to descend on. Cold start and memory are
// reported but kept out of it: they move for reasons the code cannot control.
const totalOf = (results) => WORK_METRICS.reduce((sum, key) => sum + results[key], 0);

const results = await measure();
results.total_work_ms = Number(totalOf(results).toFixed(3));

const baselineFlag = process.argv.indexOf('--baseline');
const baselinePath = baselineFlag === -1 ? null : process.argv[baselineFlag + 1];
const baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
} else {
    const width = Math.max(...Object.keys(results).map((key) => key.length));
    for (const [key, value] of Object.entries(results)) {
        const shown = typeof value === 'number' ? value.toFixed(3) : String(value);
        const before = baseline?.[key];
        const delta = typeof before === 'number' && before > 0
            ? `   ${(((before - value) / before) * 100).toFixed(1)}% faster than baseline`
            : '';
        console.log(`${key.padEnd(width)}  ${shown.padStart(10)}${delta}`);
    }
}

rmSync(home, { recursive: true, force: true });
