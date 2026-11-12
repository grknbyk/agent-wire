// agent-wire for pi. Claude Code delivers the channel through a UserPromptSubmit hook that runs
// `agent-wire drain`; pi has no such hook, so a channel set to ask or read said nothing in pi, and
// every pi session shared one scope (the folder), so one session reading a message marked it read
// for all of them. This extension does the hook's job and gives each pi session its own scope:
// - the MCP server is registered here with AGENT_WIRE_SCOPE = the pi session id, so inbox marks
//   read for this session only (a server of the same name in mcp.json would take precedence:
//   remove that entry when installing this);
// - before every run, `agent-wire drain` puts what is waiting into the prompt, as the hook does.
// An idle session is never woken by the channel: anyone who can write there could otherwise start
// a turn with shell access while nobody watches (owner, 05.11). What arrives waits for the next prompt.
// Install: pi install npm:@grknbyk/agent-wire. A copy of this file alone in ~/.pi/agent/extensions
// works too, without the screen. AGENT_WIRE_BIN names another binary.
import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const TYPE = "agent-wire";
const WINDOWS = process.platform === "win32";

// agent-wire by its full path, from PATH's absolute folders only. Given a bare name, cmd.exe,
// libuv and cross-spawn (which starts pi's MCP servers) look in the current folder first, so a
// repo holding agent-wire.cmd would run in its place (security scan, 05.11).
function onPath(name: string): string | null {
	if (isAbsolute(name)) return name;
	const extensions = WINDOWS ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const folder of (process.env.PATH ?? process.env.Path ?? "").split(WINDOWS ? ";" : delimiter)) {
		if (!folder || !isAbsolute(folder)) continue;
		for (const extension of extensions) {
			const file = join(folder, `${name}${extension.toLowerCase()}`);
			if (existsSync(file)) return file;
		}
	}
	return null;
}

const BIN = onPath(process.env.AGENT_WIRE_BIN || "agent-wire");

// npm installs a .cmd shim on Windows, which runs only through a shell: there the full path goes
// quoted at the head of one command line, and the words after it are fixed or checked below.
const runBin = (args: string[], env: NodeJS.ProcessEnv, done: (error: Error | null, stdout: string, stderr: string) => void) => {
	const options = { env, timeout: 20_000, windowsHide: true };
	if (!BIN) return done(new Error("agent-wire is not on PATH"), "", "");
	if (WINDOWS) exec(`"${BIN}" ${args.join(" ")}`, options, done);
	else execFile(BIN, args, options, done);
};

// What pi sends for a key, as the readline key the screen's `press` takes.
const NAMED = ["up", "down", "left", "right", "tab", "escape", "backspace"] as const;
const keyOf = (data: string) => {
	if (matchesKey(data, "ctrl+c")) return { ctrl: true, name: "c" };
	if (matchesKey(data, "enter")) return { name: "return" };
	const name = NAMED.find((each) => matchesKey(data, each));
	return name ? { name } : { sequence: decodeKittyPrintable(data) ?? data };
};

// The Read and Write screen of the terminal command, drawn by pi. False when there is nothing to
// draw it with (pi runs without a screen, or this file was copied without the package beside it):
// the caller shows the status card then.
async function showScreen(ctx: ExtensionCommandContext): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const screen = await import("../../src/tui.mjs").catch(() => null);
	if (!screen) return false;
	const loaded = await screen.loadScreen();
	if (!loaded.ok) {
		ctx.ui.notify(loaded.reason, "error");
		return true;
	}
	let state = loaded.state;
	const rows = Math.min(Math.max((process.stdout.rows ?? 30) - 8, 10), 24);
	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => ({
		invalidate() {},
		// pi stops on a row wider than the terminal, and it measures wide characters itself.
		render: (width: number) =>
			screen.render(state, { rows, columns: width, color: !process.env.NO_COLOR }).map((row: string) => truncateToWidth(row, width)),
		handleInput(data: string) {
			if (isKeyRelease(data)) return;
			state = screen.press(state, keyOf(data));
			if (state.change) {
				// A change that cannot be written must not stay on the screen as if it had been.
				try {
					screen.saveChange(state.change);
				} catch (error) {
					ctx.ui.notify(`not saved: ${(error as Error).message}`, "error");
					return done(undefined);
				}
			}
			if (state.done) return done(undefined);
			tui.requestRender();
		},
	}));
	return true;
}

export default function (pi: ExtensionAPI) {
	let scope = "";
	const drain = () =>
		new Promise<string>((resolve) => {
			runBin(["drain"], { ...process.env, AGENT_WIRE_SCOPE: scope }, (error, stdout) => resolve(error ? "" : stdout.trim()));
		});

	pi.on("session_start", async (_event, ctx) => {
		scope = ctx.sessionManager.getSessionId();
		if (!BIN) return;
		pi.registerMcpServer("agent-wire", {
			command: BIN,
			args: ["serve"],
			env: { AGENT_WIRE_SCOPE: scope },
			description: "agent-wire: messages with other AI agents through a shared Slack channel",
		});
	});

	pi.on("before_agent_start", async () => {
		if (!scope) return;
		const text = await drain();
		if (!text) return;
		// The model gets the whole delivery; the chat shows this one line of it.
		const summary = await import("../../src/drain.mjs").catch(() => null);
		const line = summary?.deliveryLine(text) ?? text.split("\n")[0];
		return { message: { customType: TYPE, content: text, display: true, details: { line } } };
	});

	// Expanded (the key that opens tool output), pi draws the whole text in its own block; so does
	// a message from before the line existed.
	pi.registerMessageRenderer<{ line?: string }>(TYPE, (message, { expanded, outputPad }, theme) => {
		const line = message.details?.line;
		if (expanded || !line) return undefined;
		// Names in the line come from Slack: no control characters reach the terminal.
		const row = " ".repeat(outputPad) + theme.fg("muted", line.replace(/[\x00-\x1f\x7f]/g, ""));
		return { invalidate() {}, render: (width: number) => [truncateToWidth(row, width)] };
	});

	// pi shows no MCP prompts, so the manual form lives here: "/agent-wire #dev-agents read" sets a
	// mode for this session, "/agent-wire #dev-agents" pulls what waits there into a turn now, and
	// "/agent-wire" alone opens the Read and Write screen (the status card where there is no screen).
	const run = (args: string[]) =>
		new Promise<string>((resolve) => {
			runBin(args, { ...process.env, AGENT_WIRE_SCOPE: scope }, (error, stdout, stderr) =>
				resolve((stdout || stderr || String(error ?? "")).trim()),
			);
		});
	pi.registerCommand("agent-wire", {
		description: "agent-wire: alone opens the Read and Write screen; [#channel] [read|ask|off] sets a mode or reads the waiting messages now",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const mode = words.find((word) => ["read", "ask", "off"].includes(word.toLowerCase()))?.toLowerCase();
			const channel = words.find((word) => word.toLowerCase() !== mode)?.replace(/^#/, "");
			// On Windows the words reach a shell (the .cmd shim needs one), so only a plain channel
			// name goes through: Slack names are lowercase letters, digits, - and _.
			if (channel && !/^[a-z0-9_-]{1,80}$/i.test(channel)) {
				ctx.ui.notify(`not a channel name: ${channel}`, "error");
				return;
			}
			if (mode) {
				ctx.ui.notify((await run([mode, ...(channel ? [channel] : [])])).split("\n")[0], "info");
				return;
			}
			if (!channel && words.length === 0) {
				if (!(await showScreen(ctx))) ctx.ui.notify(await run(["status"]), "info");
				return;
			}
			pi.sendUserMessage(`Call the agent-wire inbox tool with channel "${channel}" and read what it returns. Tell me in a few lines who wrote and what they need; answer an agent only where the message is addressed to you.`);
		},
	});
}
