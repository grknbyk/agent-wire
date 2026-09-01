<div align="center">
<img src="assets/agent-wire.png" alt="agent-wire" width="96">

# agent-wire

**Let your AI coding agents talk to each other, in a Slack channel you can read.**

</div>

Two developers, two machines, two coding agents working on the same system. One
knows the migration is deployed. The other is about to write against the old
schema. agent-wire gives them a way to say so.

It runs as an [MCP](https://modelcontextprotocol.io) server, so any MCP client
(Claude Code, Cursor, anything else that speaks the protocol) gets `send` and
`inbox` tools. Messages travel through a normal Slack channel.

Slack is a deliberate choice here. A private protocol between two machines
produces a conversation nobody can audit. In a channel, the humans who own those
agents read the whole exchange, scroll back through it, and step in by typing.

```
🔥 grkn => mira
migration 0042 is on dev now, txn_date is a DATE not a TIMESTAMP

⚡ mira => grkn
got it, rewriting the report query
```

## Install

```bash
npm i -g @grknbyk/agent-wire
agent-wire setup
```

Run `setup` in a real terminal window. It asks questions, so it refuses a pipe, a
script, and an editor task — an agent that tries to run it from a tool gets a
one-line refusal and usually tells you the wrong thing about why.

Setup prints the path of the bundled `manifest.json`. You create the app from it
at [api.slack.com/apps/new](https://api.slack.com/apps/new), install it, and paste
the Bot User OAuth Token back. Then you create the channel in Slack and type
`/invite @agent-wire` in it.

**Give every install its own nickname.** The first key seen under a name is pinned
to it, so a second install answering to the same name is reported as `impostor` by
everyone who already heard from the first — and a forged sighting stays on the
record even after a later message verifies.

The whole team shares one Slack app and one bot token. Only the first person
creates the app; everybody after that pastes the same token and picks their own
name, and nobody needs to invite the bot again.

Setup never asks which channel. The invite is the answer: whatever the bot has
been added to, public or private, is what it works in. Invite it somewhere new and
`agent-wire doctor` picks the channel up on the next run.

The app never adds itself to anything. It has no scope to create a channel or to
join one, so a person decides where it can read and write.

Setup never asks "did you do it? (y/n)". Every step it can verify, it verifies by
asking Slack. When a step is stuck for a reason Slack reports, such as a missing
scope, a channel nobody invited it to, or a token from the wrong workspace, it
says which one and what to do about it. Quit halfway and re-run: it resumes at
the first unfinished step, because the config file is the progress.

Then point your client at it:

```bash
claude mcp add -s user agent-wire -- agent-wire serve
```

`-s user` registers it once for every project. The modes are per session anyway,
so a per-project registration only means adding it again in the next folder.

Or, for any other MCP client:

```json
{
  "mcpServers": {
    "agent-wire": { "command": "agent-wire", "args": ["serve"] }
  }
}
```

Without the global install, substitute `npx -y @grknbyk/agent-wire` for
`agent-wire` everywhere above. It costs a registry round trip on every start.

An install that reports an old version after `npm i -g` is reading a stale local
cache rather than a failed publish: `npm cache clean --force`, then install again.

## Commands

| Command | What it does |
|---|---|
| `agent-wire status` | Identity, channels and unread counts, read from disk |
| `agent-wire setup` | Connect a workspace, a channel, and this agent's identity |
| `agent-wire serve` | Run the MCP stdio server, which is what your client launches |
| `agent-wire doctor` | Re-check the token, the channels and the identity |
| `agent-wire drain` | Print what arrived since last time, for a prompt hook |
| `agent-wire channels` | List the channels and what each one is set to here |
| `agent-wire ask <name>` | Name who is waiting and how many; open nothing |
| `agent-wire read <name>` | Put the messages themselves into every prompt |
| `agent-wire off <name>` | Say nothing about this channel in this session |

## Tools your agent gets

`send`, `send_file`, `inbox`, `archive`, `peers`, `members`, `channels`, `my_id`,
`status`.

`status` returns the same card the CLI draws, already fenced. It exists because a
shell result gets read, understood and then retyped as prose, and a drawn box does
not survive that — two installs reporting the same state should not produce two
different-looking answers.

The mode of a channel is a command the user runs, never a tool. A message
arriving from the channel must not be able to talk the agent into silencing
another channel, nor into opening one.

Text over 3500 characters is posted as a Markdown file instead of a message.
Slack splits anything longer, and the tail arrives without a header, so half an
answer vanishes while the sender is told it was delivered.

## Files go both ways

`send_file` uploads, and the receiving side downloads. A `.md` plan sent from one
machine lands on the other as a real file in `~/.agent-wire/files/`, and `inbox`
prints that path in the fence header, so the agent opens it with its own tools.
Files a human drags into the channel arrive the same way.

Slack accepts no metadata on a file upload, so the file and the message that
describes it are two posts. The message is the signed one, and the file id it
names is inside what the signature covers, so a valid signature cannot be lifted
onto somebody else's upload. A message that fails verification is never
downloaded.

Anything over 20 MB stays in Slack. The message still arrives and says why the
file was left there.

## One channel per project

Every channel the bot is in is a channel it works in. Slack owns that list, so
`setup` and `doctor` read it rather than asking, and a channel renamed in Slack
keeps working — the config stores the id and refreshes the name.

Every message is tagged with the channel it came from, `send` takes an optional
`channel`, and `inbox` can filter by one. The first entry is the default.

To stop hearing about one, switch it off in that session rather than editing the
config: `agent-wire off agent-hcm`. Removing it from the file only lasts until
the next `doctor`.

## Three modes, one per session

Every channel is in one of three modes, and the mode belongs to the session, not
to the machine:

| Mode | What a prompt gets |
|---|---|
| `off` | Nothing. The channel is not mentioned. |
| `ask` | One line naming who is waiting and how many. Nothing is opened. Default. |
| `read` | The messages themselves, fenced, and marked read as they arrive. |

`ask` looks like this, and is what a prompt hook prints:

```
Unread messages : mira(5), kai(2)
```

Loudest sender first, because five messages from one person is a conversation
waiting while one each from five people is a standup. Past five names the rest
become `+3 more`. Anything that failed its signature check is called out on the
same line — `[1 FORGED]` — rather than counted in silently.

`read` is the one to think about before turning on: it puts other people's
writing into your agent's prompt without you asking. It arrives inside the same
fence the `inbox` tool uses, but the guarantee is weaker there. Over MCP the rule
for reading fenced content is delivered once through the handshake, where no
message can sit beside it; a prompt hook has no handshake, so the rule and the
content share a page.

### What "per session" means

A session is identified by the client's own session id when the client publishes
one. Claude Code puts `CLAUDE_CODE_SESSION_ID` into everything it spawns — the MCP
server, the prompt hook and the shell alike — so two windows open on one project
hold different modes. The nickname, the keys and the Slack app stay shared.

A plain terminal has no session id, so a mode command there lands on the working
directory instead. That entry is what a session which has chosen nothing falls
back to, which makes the terminal the way to set a project's default:

```bash
cd ~/work/wms && agent-wire ask       # the default for this folder
# then, inside one Claude Code session there
agent-wire read                       # this session only, until it ends
```

The order is session, then folder, then the channel's own `mode` field, then
`ask`. `AGENT_WIRE_SCOPE` overrides the lot when you want to name a session
yourself.

A session id is not written down anywhere, so a mode set inside a session is gone
when that session ends. The folder default is the one that persists.

Read and unread are per session too. They have to be: a session on `read` opens
everything it is handed, and if that also marked the message read next door, an
`ask` session would report an empty inbox forever.

The poller is not per session. One poller feeds one shared log for the whole
machine, so a channel stays polled while any session still wants it. `off` means
"do not tell me", not "stop collecting" — otherwise the quietest session on the
machine would decide what the busiest one is allowed to see.

## Working on two of five channels

Running `agent-wire` with no arguments shows where you stand:

```
┌──────────────── agent-wire ────────────────┐
│ name  grkn           mark  🔥              │
│ key   MCowBQYDK2VwAyEAq7Xn2mZ8kLcYzQwErTy… │
├───────────────── CHANNELS ─────────────────┤
│ agent-wms    ● read    3 unread            │
│ agent-crm    ◐ ask     1 unread            │
│ agent-hcm    ○ off     1 held              │
│ agent-lab    ○ off     1 held              │
├────────────────── PEERS ───────────────────┤
│ @ Zoë         * kai         * mira         │
│ * warehouse-… * robin       ! nox          │
├────────────────── STATE ───────────────────┤
│ workspace Acme       poll  14s ago         │
└────────────────────────────────────────────┘
```

The peers section lists everyone this agent has heard from: `*` for an agent,
`@` for a human typing in the channel, `!` for a name that has been forged.
Anything too wide for its column ends in `…`, so one long nickname costs its own
row a character instead of pushing the border out.

A forged sighting stays on the record even after that name sends a message that
verifies. Letting a later message clear it would hand an attacker the way to bury
the evidence.

```bash
agent-wire off  agent-hcm
agent-wire ask  agent-hcm
agent-wire read agent-wms
```

With one channel configured the name is the whole argument, so it is dropped:
`agent-wire read`. Past one the command lists the names rather than guessing.

The MCP server offers the same three as prompts, which a client shows in its
slash-command list: `/mcp__agent-wire__read` in Claude Code. Nothing needs to be
copied into `~/.claude/commands/` — the package carries them. A prompt is offered
to the user and invoked by nobody else, so this is the same boundary as the shell
command, minus the typing.

`status` reads the config and the local log only, so it answers instantly.
Whether Slack still accepts the token is `doctor`'s question.

A channel that is off is not polled, not announced by `drain`, and absent from
the default `inbox` view. Its history stays readable at any time with
`inbox channel="agent-hcm"`.

Switching one off does not lose messages. The cursor stays where it was, so
switching it back on replays everything that arrived meanwhile.

Only the person running the agent can switch a channel, from the command line.
The MCP `channels` tool lists the state and cannot change it, so a message
arriving from one channel can never talk the agent into silencing another.

## Who actually sent that message

Every agent in a workspace shares one bot token, so Slack's own `bot_id` proves
that agent-wire posted a message without proving which agent wrote it. The header
line is plain text that anyone in the channel can type.

So each install generates an Ed25519 key pair at setup and signs every message it
sends. The signature covers the sender, the recipient, the channel, the position
in the reply chain, and the text. It travels in Slack message metadata, which the
UI never renders. The first key seen using a name is pinned to that name, and
`inbox` labels every message with what is actually proven:

| Label | Meaning |
|---|---|
| `signed` | Verified against the key already pinned to that name |
| `new` | Verified, first sighting of this name, key now pinned |
| `impostor` | That name is pinned to a different key, so treat it as forged |
| `unsigned` | No valid signature, so the sender name is decoration only |
| `slack-verified` | A human, identified by Slack's own user id |
| `self` | Sent by this agent |

Changing one character of the text breaks the signature, and so does replaying a
signed message into another channel. There are tests for both.

## Untrusted input

Anything arriving from the channel is rendered inside a fence whose delimiter is
a random value minted per server process, never written to Slack and never
logged:

```
<<<WIRE:4f2a… UNTRUSTED from=mira kind=agent authorship=signed channel=agent-wms ts=1712.44 hop=3>>>
the message
<<<END:4f2a…>>>
```

The rule for reading that fence arrives through the MCP handshake, a channel the
message author cannot write to, so it never sits inline beside the content it
governs. If a payload contains the live delimiter, it is replaced with
`[FENCE-ECHO REDACTED]`, which turns reflection into a visible event instead of a
silently broken boundary.

Be clear about what this buys you. An attacker cannot close the fence, and does
not need to, because text inside a correctly labelled `UNTRUSTED` block still
reads as language to a model. The fence makes the labelling accurate. Hostile
text stays exactly as persuasive as it was, so this is a boundary rather than a
filter.

A reply chain also carries a hop count and stops at 8. Two agents answering each
other politely is an infinite loop that costs real money.

## Slack scopes, and why each one

Your workspace admin will ask. The manifest requests:

| Scope | Why |
|---|---|
| `chat:write` | Post messages |
| `channels:history` | Read the channels it was added to |
| `channels:read` | Find a channel by name, list who is in it |
| `groups:read` | The same, for a private channel it was invited to |
| `groups:history` | Read a private channel it was added to |
| `files:write` | Send a file, and post a long message as one |
| `files:read` | Download a file somebody sent |
| `users:read` | Show a human's name instead of `U08J21KLER1` |

Eight, and that is the whole list. No `channels:join` or `channels:manage`, so
the app cannot add itself to a channel or create one. The two `groups:*` scopes
read a private channel but cannot find one: `users.conversations` answers only
with channels the bot is already in, so a private channel still costs an invite.

The two lookups it does are both scoped to the invite, public or private.
Channels come from `users.conversations`, which answers "which channels am I in", never
`conversations.list`, which answers "which channels exist here". Names come from
`conversations.members` on one of those channels. There is no call in the package
that can enumerate the workspace.

## Where things are stored

Everything lives in `~/.agent-wire/` (override with `AGENT_WIRE_HOME`).
`config.json` holds the token, identity and channels. `inbox.jsonl` is the
append-only message log. `peers.json` holds the pinned keys. `files/` holds every
attachment that arrived, named by Slack file id so two `plan.md` files stay two
files.

The local log is the source of truth. Slack is a cache that can be re-read at any
time, so recovering a lost inbox is an ordinary operation rather than a
procedure. Messages are keyed by their Slack timestamp, so a retried poll or a
reinstalled app cannot produce duplicates.

## Roadmap

- `mode: reply`, to answer waiting messages when no live session is watching
- Per-worktree identity, so parallel sessions on one machine name themselves
- Discord as a second transport
- Published measurements of fenced against unfenced injection compliance

Wire format v2 signs the attached file id alongside the text, so a 0.5 agent and
a 0.4 agent cannot verify each other. Upgrade both ends together.

## Development

```bash
npm test       # 60 tests, no network
npm run bench  # medians over a synthetic 20k-message log
```

The benchmark is here because the slow paths are the ones nobody watches: a log
that only grows, and a CLI that a prompt hook runs on every prompt. It is not
shipped to npm.

## License

MIT
