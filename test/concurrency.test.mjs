import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'agent-wire-test-'));
process.env.AGENT_WIRE_HOME = home;

const { mapLimit } = await import('../src/slack.mjs');
const { pollOnce } = await import('../src/sync.mjs');

test.after(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A pid that has certainly been released: a child that has already exited. A
// made-up number is not portable. 999999 is free here and cannot be a Windows
// pid, but a Linux host with pid_max raised, which systemd and containers do,
// can have it running, and these tests would then sit out the whole timeout.
const exitedPid = async () => {
    const { spawn } = await import('node:child_process');
    return new Promise((done) => {
        const child = spawn(process.execPath, ['--version'], { stdio: 'ignore' });
        child.on('exit', () => done(child.pid));
    });
};

test('nothing to do is not a round trip', async () => {
    let ran = 0;
    assert.deepEqual(await mapLimit([], 4, async () => { ran++; }), []);
    assert.equal(ran, 0);
});

test('one item works, and a limit wider than the list works', async () => {
    assert.deepEqual(await mapLimit(['a'], 4, async (item) => item.toUpperCase()), ['A']);
    assert.deepEqual(await mapLimit(['a', 'b'], 99, async (item) => item.toUpperCase()), ['A', 'B']);
});

// The one that would corrupt data rather than merely slow it down: a name
// resolved for one user landing against another user's id.
test('results keep input order even when the slowest replies first', async () => {
    const delays = [40, 0, 30, 10, 20];
    const done = await mapLimit(delays, 3, async (delay, index) => {
        await sleep(delay);
        return index;
    });

    assert.deepEqual(done, [0, 1, 2, 3, 4]);
});

test('a limit of one is exactly the serial loop it replaced', async () => {
    const order = [];
    await mapLimit([3, 2, 1], 1, async (item) => {
        order.push(`start${item}`);
        await sleep(item);
        order.push(`end${item}`);
    });

    assert.deepEqual(order, ['start3', 'end3', 'start2', 'end2', 'start1', 'end1']);
});

test('the limit is a ceiling, not a target', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapLimit(Array.from({ length: 20 }, (unused, index) => index), 4, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
    });

    assert.equal(peak, 4);
});

test('a task that throws rejects the whole call, as an await in a loop did', async () => {
    await assert.rejects(
        () => mapLimit([1, 2, 3], 2, async (item) => {
            if (item === 2) throw new Error('slack said no');
            return item;
        }),
        /slack said no/,
    );
});

// A broken channel used to take everybody else's messages down with it. It is
// caught per channel now, so the other channels still land.
test('one failing channel does not cost the other channels their messages', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const method = String(url).split('/api/')[1];
        if (method === 'conversations.history') {
            return { status: 200, ok: true, json: async () => ({ ok: true, has_more: false, messages: [] }) };
        }
        throw new Error('network down');
    };

    const { saveConfig } = await import('../src/config.mjs');
    saveConfig({
        version: 1,
        nickname: 'grkn',
        bot_token: 'xoxb-test',
        channels: [{ id: 'C1', name: 'one' }, { id: 'C2', name: 'two' }],
    });

    // Nothing throws out of pollOnce even though every user lookup would.
    assert.equal((await pollOnce((await import('../src/config.mjs')).loadConfig())).added, 0);
    globalThis.fetch = realFetch;
});

// Four processes, each marking 200 different messages read. Before the lock this
// kept 226 of 800 on this machine, and on Windows it threw EPERM as well, because
// renaming onto a file another process holds open is refused there.
test('a message marked read in one process is not lost by another', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, readFileSync: read, rmSync: remove } = await import('node:fs');

    const PROCESSES = 4;
    const COUNT = 200;
    const racing = mkdtempSync(join(tmpdir(), 'agent-wire-race-'));

    // A worker file rather than --eval: an inline script that spawns processes is
    // the shape Windows Defender's SuspExec heuristic blocks, and a blocked worker
    // would look exactly like the bug this test is here to catch.
    const workerFile = join(racing, 'worker.mjs');
    writeFileSync(workerFile, [
        `import { markRead } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src', 'inbox.mjs')).href)};`,
        `for (let index = 0; index < ${COUNT}; index++) {`,
        '    markRead([{ channel: \'c\', ts: `${process.argv[2]}.${index}` }]);',
        '}',
    ].join('\n'));

    const codes = await Promise.all(Array.from({ length: PROCESSES }, (unused, id) => new Promise((done) => {
        spawn(process.execPath, [workerFile, String(id)], {
            env: { ...process.env, AGENT_WIRE_HOME: racing, AGENT_WIRE_SCOPE: 'race' },
            stdio: 'ignore',
        }).on('exit', done);
    })));

    // The exit codes come first: when every worker dies there is no states.json
    // to read, and reading it first replaced the message that says so with ENOENT.
    try {
        assert.deepEqual(codes, Array(PROCESSES).fill(0), 'a worker crashed, which is the EPERM the lock removes');
        const kept = Object.keys(JSON.parse(read(join(racing, 'states.json'), 'utf8'))).length;
        assert.equal(kept, PROCESSES * COUNT, `${PROCESSES * COUNT - kept} marks were lost to a concurrent write`);
    } finally {
        remove(racing, { recursive: true, force: true });
    }
});

// The lock a dead holder left behind was its own kind of outage: until the
// reclaim knew to look at the pid, the next caller sat out the whole timeout and
// then threw, so one process killed mid-write broke every later one.
test('a lock left behind by a dead process is taken, not waited out', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 'dead-holder.json');
    writeFileSync(`${target}.lock`, String(await exitedPid()));

    const started = Date.now();
    assert.equal(withLock(target, () => 'reclaimed'), 'reclaimed');
    assert.ok(Date.now() - started < 1000, 'the reclaim waited instead of reading the pid');
});

// Our own pid in a lock file can only be our own leftover, because withLock is
// synchronous: there is no second place in this process that could be holding
// it. Reading kill literally there cost the process every later write to that
// file, a timeout and a throw at a time, for as long as it ran.
test('a leftover lock holding our own pid does not lock us out', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 'own-pid.json');
    writeFileSync(`${target}.lock`, String(process.pid));

    const started = Date.now();
    assert.equal(withLock(target, () => 'retaken'), 'retaken');
    assert.ok(Date.now() - started < 1000, 'the process waited for itself');
});

// A pid outlives its process and the lock file outlives the machine, so after a
// reboot the number in an abandoned lock belongs to somebody else. Believing
// kill then meant nothing could ever reclaim the file, and deleting it by hand
// was the only way back.
test('a lock old enough that its pid has been reused is taken anyway', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 'reused-pid.json');
    const lockFile = `${target}.lock`;
    writeFileSync(lockFile, String(process.ppid)); // alive, and not ours
    const longAgo = new Date(Date.now() - 660000);
    utimesSync(lockFile, longAgo, longAgo);

    assert.equal(withLock(target, () => 'reclaimed'), 'reclaimed');
});

// Taking an abandoned lock used to be three steps, check then delete then
// create, and a second waiter that checked before the winner's delete and
// deleted after its create got inside the section too. 25 rounds of this found
// 73 overlaps against that shape and none against the rename.
test('two processes racing one abandoned lock do not both get inside it', async () => {
    const { spawn } = await import('node:child_process');

    const ROUNDS = 8;
    const RACERS = 4;
    const target = join(home, 'race-reclaim.json');
    const lockFile = `${target}.lock`;
    const logFile = join(home, 'sections.log');
    const workerFile = join(home, 'reclaim-worker.mjs');
    const configUrl = pathToFileURL(join(process.cwd(), 'src', 'config.mjs')).href;

    // A worker file rather than --eval, for the same reason as the test below:
    // an inline script that spawns processes is the shape Defender blocks here.
    // Both ends of the section are timestamped from inside it, so an overlap in
    // the tail after the work is as visible as one at the front.
    writeFileSync(workerFile, [
        `process.env.AGENT_WIRE_HOME = ${JSON.stringify(home)};`,
        `const { withLock } = await import(${JSON.stringify(configUrl)});`,
        "const { appendFileSync } = await import('node:fs');",
        `const log = ${JSON.stringify(logFile)};`,
        `withLock(${JSON.stringify(target)}, () => {`,
        "    appendFileSync(log, process.pid + ' enter ' + Date.now() + '\\n');",
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
        "    appendFileSync(log, process.pid + ' exit ' + Date.now() + '\\n');",
        '});',
    ].join('\n'));

    let overlaps = 0;
    for (let round = 0; round < ROUNDS; round++) {
        writeFileSync(logFile, '');
        // Abandoned, so all four race the reclaim at once. An empty lock backdated
        // past the staleness window rather than a planted pid: the racers are node
        // processes drawing from the same pid pool, and one of them being handed
        // the planted number would leave the lock looking held by somebody alive.
        writeFileSync(lockFile, '');
        const longEnoughAgo = new Date(Date.now() - 5000);
        utimesSync(lockFile, longEnoughAgo, longEnoughAgo);
        const codes = await Promise.all(Array.from({ length: RACERS }, () => new Promise((done) => {
            spawn(process.execPath, [workerFile], { stdio: 'ignore' }).on('exit', done);
        })));

        // Without these two the test passed on an empty log: every racer throwing
        // leaves nothing to compare, and nothing to compare has no overlaps in it.
        assert.deepEqual(codes, Array(RACERS).fill(0), 'a racer threw instead of taking the lock');

        const marks = new Map();
        for (const line of readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)) {
            const [pid, phase, at] = line.split(' ');
            if (!marks.has(pid)) marks.set(pid, {});
            marks.get(pid)[phase] = Number(at);
        }
        const sections = [...marks.values()].map(({ enter, exit }) => [enter, exit])
            .sort(([left], [right]) => left - right);
        assert.equal(sections.length, RACERS, 'a racer never got inside the section');

        for (let index = 1; index < sections.length; index++) {
            if (sections[index][0] < sections[index - 1][1]) overlaps++;
        }
    }

    assert.equal(overlaps, 0, `${overlaps} sections overlapped, so two processes held the lock together`);
});

// Releasing by path alone was its own hazard. A holder declared gone while it
// was still inside the section deleted whatever stood at that path, and by then
// the path held the lock of the process that had taken it, so the release let a
// third one in while the second was still writing.
test('a holder that lost its lock does not delete the next one', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 'robbed.json');
    const lockFile = `${target}.lock`;

    withLock(target, () => {
        // Somebody decided we were dead, took the lock, and is inside it now.
        rmSync(lockFile, { force: true });
        writeFileSync(lockFile, '424242 someone-else');
    });

    assert.equal(readFileSync(lockFile, 'utf8'), '424242 someone-else');
    rmSync(lockFile, { force: true });
});

// Reading our own pid as a dead holder is only safe while nothing in this
// process can be holding the lock already, so re-entry has to be the loud kind
// of mistake. Silently, the inner call would take the outer's lock, both frames
// would run inside the section, and the inner release would hand it away.
test('withLock refuses to be re-entered for the same file', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 're-entry.json');

    assert.throws(
        () => withLock(target, () => withLock(target, () => 'inner')),
        /re-entered/,
    );
    // The outer frame still released, so the next caller is not locked out.
    assert.equal(withLock(target, () => 'free'), 'free');
});

// The other direction of the same question, and the one that costs data: a lock
// taken a moment ago by a process that is still running must not be taken away,
// whatever its age or its pid would suggest on their own. Failing out loud here
// is the correct answer, and the ten seconds are LOCK_TIMEOUT_MS going by.
test('a fresh lock held by a live process is waited for, not taken', async () => {
    const { withLock } = await import('../src/config.mjs');
    const target = join(home, 'live-holder.json');
    const lockFile = `${target}.lock`;
    writeFileSync(lockFile, `${process.ppid} not-ours`); // alive, and not this process

    assert.throws(() => withLock(target, () => 'ROBBED A LIVE HOLDER'), /held by another process/);
    assert.equal(readFileSync(lockFile, 'utf8'), `${process.ppid} not-ours`, 'the lock was overwritten');
    rmSync(lockFile, { force: true });
});
