# agent-wire

An MCP stdio server that lets AI coding agents message each other through a shared Slack
channel. Published as `@grknbyk/agent-wire`.

## What runs it

Node 20 or newer, and nothing else. There are no runtime dependencies and there will not be
any: every import is either a `node:` builtin or another file in `src/`. Check `dependencies`
before reaching for a package.

`npm test` is `node --test "test/*.test.mjs"`. Where `node` on the path is a bun shim, call
`/usr/bin/node --test "test/*.test.mjs"` instead.

## What must not be touched, and why

`files` in package.json is a whitelist: `bin`, `src`, `assets`, `manifest.json`. `bench/`,
`tools/` and `test/` are not shipped, so a path that reaches them from `src/` breaks the
published package and not the checkout. Verify a packaging change with `npm pack --dry-run`.

Publishing is not a local act. Since 0.18.0 the installed clients self-update, so `npm publish`
reaches every machine in the channel without anybody asking for it. Run `/code-review` on the
diff first.

Never add a Windows Defender exclusion to make something run. The fix is the shape of the
command: an inline `node -e` that kills a process and spawns a detached child trips
`Trojan:Win32/SuspExec.SE`, and so does a hidden `cmd.exe` that chains an install with `&&`.
`src/version.mjs` calls npm through `execFile` on `npm-cli.js` with no shell for this reason.

Every file in the repo is CRLF. A script that patches source has to normalise to LF, edit, and
restore CRLF, or the diff is the whole file.

## How to verify a change

`npm test` — 150 tests across 15 files.

A change to the lock in `src/config.mjs` needs more than a green suite, because the suite was
green through two rounds of confirmed concurrency bugs. Each guard in
`test/concurrency.test.mjs` has to be run against the shape it exists to catch: remove the
branch, see the test fail, put it back. A concurrency test that cannot fail is the default
outcome, not the unlikely one.

## Burns

`openSync(path, 'wx')` answers EPERM on Windows, not EEXIST, both when the target exists and
while a delete on it is still pending. A lock that caught only EEXIST killed four of four
racing workers.

A pid in a lock file is not proof that a holder is alive. It can be this process's own
leftover, from a release whose delete failed, and after a reboot it can be a number the
kernel has handed to somebody unrelated. Either one made the file permanently unlockable.
`kill(pid, 0)` also answers EPERM, not ESRCH, for a process owned by another user.

`renameSync` onto a file another process holds open throws EPERM on Windows. That is why
`writeJson` being atomic was never enough for read-change-write, and why taking an abandoned
lock renames it instead of deleting it.
