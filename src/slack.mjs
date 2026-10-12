// The Slack side: one thin client, the probes that setup and doctor both use, and
// the poll that turns channel history into local inbox items.
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';

import { paths, readJsonCached, writeJson } from './config.mjs';
import { checkAuthorship } from './identity.mjs';
import { HUMAN_TEXT_CAP, METADATA_EVENT, fromSlackText, parseMessage } from './protocol.mjs';
import { installedVersion } from './version.mjs';

const API = 'https://slack.com/api/';
const RATE_LIMITED = 429;
const DEFAULT_RETRY_SECONDS = 5;

// conversations.history is rate limited per workspace, and the whole team shares
// one app. Retrying a 429 forever meant a rate-limited machine waited forever, on
// every prompt, because the prompt hook polls too. Three tries, and a request that
// hangs is cut rather than waited on.
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const MEMBER_LIMIT = 200;
// The subtypes that carry a real message. The rest are joins, leaves and topic
// changes, and dropping them is the point. thread_broadcast is a thread reply also
// sent to the channel; dropping it lost the one reply Slack does show in history.
const KEPT_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

// Long enough to keep a real document name recognisable, short enough that the
// Slack file id in front of it still fits a filesystem path.
const NAME_MAX_CHARS = 80;

// Slack serves file bytes over plain HTTP, so an oversized attachment is an
// oversized write to the user's disk. Past this the file stays in Slack and the
// message says why it was left there.
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

// How many requests of one kind may be in flight. Slack rate-limits per method,
// so these are per loop rather than one global number: history is Tier 3, the
// user lookup is Tier 4, and a download is not an API call at all but does hold
// a whole file in memory while it lands.
export const CHANNEL_CONCURRENCY = 4;
const USER_CONCURRENCY = 8;
const DOWNLOAD_CONCURRENCY = 3;

// Node has no bounded Promise.all, and both ends of the choice are wrong here:
// awaiting in a loop costs one round trip per item, and an unbounded Promise.all
// throws two hundred requests at a rate limiter. The workers pull from one shared
// cursor rather than taking a slice each, so a slow reply cannot leave the others
// queued behind it.
export async function mapLimit(items, limit, run) {
    const results = new Array(items.length);
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// conversations.* reject a JSON body and chat.postMessage needs one for metadata,
// so the client speaks both and the caller picks per method. The token rides along
// because downloading a file is a plain fetch, not an API call.
// A failure comes back shaped like Slack's own answer rather than thrown, because
// every caller already reads result.ok and none of them is wrapped in a try.
export function slackClient(token, { deadline = null } = {}) {
    const timeoutFor = () => {
        if (!deadline) return REQUEST_TIMEOUT_MS;
        return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
    };

    const request = async (method, init, attempt = 1) => {
        let response;
        try {
            response = await fetch(API + method, {
                ...init,
                signal: AbortSignal.timeout(timeoutFor()),
                headers: { authorization: `Bearer ${token}`, ...init.headers },
            });
        } catch (error) {
            return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : 'network_error' };
        }
        if (response.status !== RATE_LIMITED) return response.json();

        const waitMs = Number(response.headers.get('retry-after') || DEFAULT_RETRY_SECONDS) * 1000;
        if (attempt >= MAX_RETRIES) return { ok: false, error: 'ratelimited' };
        if (deadline && Date.now() + waitMs > deadline) return { ok: false, error: 'ratelimited' };

        await new Promise((done) => setTimeout(done, waitMs));
        return request(method, init, attempt + 1);
    };

    return {
        token,
        form: (method, params) => request(method, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        }),
        json: (method, body) => request(method, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(body),
        }),
    };
}

// --- probes: read-only, and the same ones answer "is setup done" and "what
// broke". Each returns a verdict plus the reason, never a bare boolean, because
// a spinner that cannot say why it is still spinning is the worst dead-end.

export async function probeToken(client) {
    const result = await client.form('auth.test', {});
    if (result.ok) return { ok: true, teamId: result.team_id, botUserId: result.user_id, team: result.team };
    return { ok: false, reason: result.error };
}

// users.conversations, not conversations.list: the first answers "which channels
// am I in", the second answers "which channels exist in this workspace". A bridge
// has no business asking the second one, so it never does. The invite is the whole
// access control, and it is a human who types it. Private channels are asked
// for by name too. A team that kept its agent channel private was told the bot
// was in no channel by that name, while chat:write posted into it happily.
export async function joinedChannels(client) {
    const joined = [];
    let cursor = '';

    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.form('users.conversations', {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: MEMBER_LIMIT,
            cursor,
        });
        if (!result.ok) return { ok: false, reason: result.error };

        for (const channel of result.channels) joined.push({ id: channel.id, name: channel.name });

        cursor = result.response_metadata?.next_cursor ?? '';
        if (!cursor) break;
    }

    return { ok: true, channels: joined };
}


// Everyone in one channel the bot was invited to. No workspace directory call
// exists anywhere in the package, so an invite is the only way a name reaches it.
export async function listMembers(client, channelId) {
    const result = await client.form('conversations.members', { channel: channelId, limit: MEMBER_LIMIT });
    if (!result.ok) return { ok: false, reason: result.error };

    return { ok: true, names: await resolveUserNames(client, result.members) };
}

// The bot token deletes as the bot, so Slack will not stop it from taking back a
// message another agent posted through the same app. Whose message it is, is a
// question only the local log can answer, and mcp.mjs asks it before calling here.
export async function deleteMessage(client, { channel, ts }) {
    const result = await client.form('chat.delete', { channel, ts });
    return result.ok ? { ok: true } : { ok: false, reason: result.error };
}

// --- sending

// `rendered` is the whole visible message — header line plus body — because that
// is what a human scrolling the channel reads. The signature and routing fields
// travel in metadata, which Slack never renders.
// "which of us is on an old build" was a question nobody could answer without
// asking each person, so every message carries the version that sent it. Not
// signed, like the rest of the envelope around the signature: it answers a
// housekeeping question, and a sender who lies about it is lying to no effect.
export async function postMessage(client, { channel, rendered, signature, publicKey, from, to, conv, hop, file }) {
    const result = await client.json('chat.postMessage', {
        channel,
        text: rendered,
        metadata: {
            event_type: METADATA_EVENT,
            event_payload: {
                v: 2, av: installedVersion(), from, to, conv, hop, file: file ?? '', sig: signature, key: publicKey,
            },
        },
    });
    if (result.ok) return { ok: true, ts: result.ts };
    return { ok: false, reason: result.error };
}

// No initial_comment on purpose. files.completeUploadExternal carries no metadata
// field, so a file posted with its own comment arrives unsigned and cannot be
// attributed. The caller posts a signed message naming this file id instead.
// Sending a file is two halves, and which order they run in is what Slack shows.
// Uploading names no channel, so nothing is visible yet and the id already exists to
// sign the message with. Sharing is what puts the file in the channel.
//
// Done as one call, the file landed above the line describing it — file first, then
// "here is what this file is" underneath. Backwards for anyone scanning headers down
// the left edge, and the user asked for message then file.
export async function stageFile(client, { path }) {
    const bytes = readFileSync(path);
    const name = basename(path);
    const slot = await client.form('files.getUploadURLExternal', { filename: name, length: bytes.length });
    if (!slot.ok) return { ok: false, reason: slot.error };

    const upload = await fetch(slot.upload_url, { method: 'POST', body: bytes });
    if (!upload.ok) return { ok: false, reason: `upload_failed_http_${upload.status}` };

    return { ok: true, fileId: slot.file_id, name };
}

export async function shareFile(client, { channel, fileId, name }) {
    const done = await client.form('files.completeUploadExternal', {
        files: JSON.stringify([{ id: fileId, title: name }]),
        channel_id: channel,
    });
    return done.ok ? { ok: true } : { ok: false, reason: done.error };
}

// --- receiving files

// The name comes from whoever uploaded the file, so it reaches a path only after
// the separators are gone. The file id in front of it also keeps two uploads that
// share a name as two files on disk.
export const safeName = (name) => String(name ?? '').replace(/[^\w.-]/g, '_').slice(0, NAME_MAX_CHARS) || 'file';

// Slack serves the bytes from a URL that needs the bot token, which is exactly
// what the receiving agent does not have. Pulling them at poll time is what turns
// "a file was shared" into a path the agent can open.
async function downloadAttachment(client, file) {
    const source = file.url_private_download ?? file.url_private;
    if (!source) return null;
    if (Number(file.size) > DOWNLOAD_MAX_BYTES) {
        return { name: file.name, path: null, size: Number(file.size), skipped: 'larger than 20 MB' };
    }

    // A file id names the same bytes forever, so a copy already on disk is used: a
    // thread is read again until its replies are behind the reply cursor, and a
    // reader may open the same message twice.
    const localPath = join(paths.files, `${file.id}-${safeName(file.name)}`);
    if (existsSync(localPath)) return { name: file.name, path: localPath, size: Number(file.size) };

    // Caught, because a reset connection here used to throw out of the whole poll,
    // or out of the inbox tool after it had marked the messages read.
    try {
        const response = await fetch(source, { headers: { authorization: `Bearer ${client.token}` } });
        if (!response.ok) {
            return { name: file.name, path: null, size: Number(file.size), skipped: `download failed, HTTP ${response.status}` };
        }

        mkdirSync(paths.files, { recursive: true });
        writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
        return { name: file.name, path: localPath, size: Number(file.size) };
    } catch (error) {
        return { name: file.name, path: null, size: Number(file.size), skipped: `download failed, ${error.name}` };
    }
}

async function downloadAll(client, files) {
    const saved = await mapLimit(files ?? [], DOWNLOAD_CONCURRENCY, (file) => downloadAttachment(client, file));
    return saved.filter(Boolean);
}

// The same id on disk answers without asking Slack. The name is the sanitised one
// it was saved under, which is all that is left of the original.
function storedFile(fileId) {
    if (!existsSync(paths.files)) return null;
    const stored = readdirSync(paths.files).find((name) => name.startsWith(`${fileId}-`));
    if (!stored) return null;
    const path = join(paths.files, stored);
    return { name: stored.slice(fileId.length + 1), path, size: statSync(path).size };
}

export async function downloadById(client, fileId) {
    const stored = storedFile(fileId);
    if (stored) return [stored];

    const fileInfo = await client.form('files.info', { file: fileId });
    if (!fileInfo.ok) return [];

    const saved = await downloadAttachment(client, fileInfo.file);
    return saved ? [saved] : [];
}

// --- polling

// Resolved in batches because the cache is a file. One member list is 200 ids,
// and asking one at a time meant 200 reads and 200 rewrites of the same JSON to
// answer a question about names that almost never change.
async function resolveUserNames(client, userIds) {
    const known = readJsonCached(paths.users, {});
    const missing = [...new Set(userIds)].filter((userId) => !known[userId]);
    if (missing.length === 0) return userIds.map((userId) => known[userId]);

    const resolved = await mapLimit(missing, USER_CONCURRENCY, async (userId) => {
        const result = await client.form('users.info', { user: userId });
        return result.ok
            ? (result.user.profile?.display_name || result.user.real_name || userId)
            : userId;
    });

    const found = { ...known };
    missing.forEach((userId, index) => { found[userId] = resolved[index]; });
    writeJson(paths.users, found);
    return userIds.map((userId) => found[userId]);
}

// Only the messages that will become human items: an agent post carries its name
// in the signed payload, and another app's post is dropped before it is read.
async function namesInPage(client, messages) {
    const userIds = messages
        .filter((message) => message.user && !message.bot_id && message.metadata?.event_type !== METADATA_EVENT)
        .map((message) => message.user);
    const names = await resolveUserNames(client, userIds);
    return new Map(userIds.map((userId, index) => [userId, names[index]]));
}

// A human typing in the channel is worth seeing but is never a directive: it is
// capped, marked, and handed to the agent as data. Slack's own user id is the
// identity here — that field is not writable by the person typing.
async function humanItem(client, message, channel, namesById) {
    const typed = fromSlackText(message.text ?? '').trim();
    const files = await downloadAll(client, message.files);
    if (!typed && files.length === 0) return null;

    const text = typed.length > HUMAN_TEXT_CAP
        ? `${typed.slice(0, HUMAN_TEXT_CAP)}\n... ${typed.length - HUMAN_TEXT_CAP} more characters truncated`
        : typed;
    return {
        ts: message.ts,
        at: new Date(Number(message.ts) * 1000).toISOString(),
        channel: channel.name,
        channelId: channel.id,
        from: namesById.get(message.user) ?? message.user,
        userId: message.user,
        kind: 'human',
        authorship: 'slack-verified',
        hop: 1,
        text: text || `shared ${files.length} file(s)`,
        files,
    };
}

async function agentItem(client, message, channel, payload, inHurry = false) {
    const parsed = parseMessage(message.text ?? '');
    const text = parsed?.text ?? fromSlackText(message.text ?? '');
    const authorship = checkAuthorship({
        from: payload.from,
        publicKey: payload.key,
        signature: payload.sig,
        channel: channel.id,
        to: payload.to,
        conv: payload.conv,
        hop: payload.hop,
        file: payload.file ?? '',
        text,
    });

    // Fetched only after the signature holds. Pulling bytes for a message that
    // failed verification is doing an impostor's downloading for them.
    //
    // Skipped entirely when the caller is against a deadline: a prompt hook cannot
    // wait on somebody's 15 MB export, and the file is still in Slack for the next
    // poll to fetch.
    const isTrusted = authorship.verdict === 'signed' || authorship.verdict === 'new';
    const wanted = payload.file && isTrusted && !inHurry;
    const files = wanted ? await downloadById(client, payload.file) : [];
    // A file not fetched now keeps its id on the item. Without it the log named the
    // file nowhere, and the syncer's later copy that had the bytes was dropped as a
    // duplicate ts, so a message first read by handle never got its file.
    const pending = isTrusted && payload.file && files.length === 0;

    return {
        ts: message.ts,
        at: new Date(Number(message.ts) * 1000).toISOString(),
        channel: channel.name,
        channelId: channel.id,
        from: payload.from,
        to: payload.to,
        kind: 'agent',
        authorship: authorship.verdict,
        conv: payload.conv,
        hop: Number(payload.hop) || 1,
        wireVersion: payload.av ?? '',
        ref: parsed?.ref ?? '',
        text,
        files,
        ...(pending ? { fileId: payload.file } : {}),
    };
}

const isKept = (message) => !message.subtype || KEPT_SUBTYPES.has(message.subtype);

// One message to one log item, or null for a message the log does not keep.
async function itemFor(client, message, channel, { myNickname, namesById, inHurry }) {
    const payload = message.metadata?.event_type === METADATA_EVENT ? message.metadata.event_payload : null;
    if (payload?.from === myNickname) return null; // our own post, already in our log
    if (payload) return agentItem(client, message, channel, payload, inHurry);
    if (message.bot_id) return null; // another app, or the bare upload our own sidecar describes
    return humanItem(client, message, channel, namesById);
}

// conversations.history leaves thread replies out; only conversations.replies
// returns them, one thread per call. A parent can be far older than the channel
// cursor, so the parents come from the newest page of the channel, read without
// `oldest` (with it Slack answers from the old end of the range). A reply to a
// thread older than that page is not seen.
//
// Replies have their own cursor, `repliesSince`. Sharing the channel's would
// read every reply again on each poll until somebody posted at the top level,
// since a reply must not move the channel cursor past a top-level message. The
// new mark is the newest latest_reply seen in the parent read: any reply posted
// after that read is newer than it, so the next poll still finds it. The mark
// moves only when every read succeeded, so a refused thread is read again.
async function threadReplies(client, channel, { repliesSince, myNickname }) {
    const recent = await client.form('conversations.history', { channel: channel.id, limit: PAGE_LIMIT });
    if (!recent.ok) return { replies: [], newestReply: null };

    const parents = recent.messages.filter((message) =>
        message.reply_count > 0 && Number(message.latest_reply) > Number(repliesSince));
    const replies = [];
    for (const parent of parents) {
        // Every page, because the mark below jumps to the thread's latest reply:
        // a reply left on an unread page would sit behind it for good.
        let cursor = '';
        for (let page = 0; page < MAX_PAGES; page++) {
            const thread = await client.form('conversations.replies', {
                channel: channel.id,
                ts: parent.ts,
                oldest: repliesSince,
                limit: PAGE_LIMIT,
                include_all_metadata: true,
                ...(cursor ? { cursor } : {}),
            });
            if (!thread.ok) return { replies: [], newestReply: null };

            // The parent comes back first in every answer, whatever oldest says.
            replies.push(...thread.messages.filter((message) =>
                message.ts !== parent.ts && Number(message.ts) > Number(repliesSince) && isKept(message)));

            cursor = thread.response_metadata?.next_cursor ?? '';
            if (!thread.has_more || !cursor) break;
        }
    }

    const namesById = await namesInPage(client, replies);
    const items = [];
    for (const reply of replies) {
        const item = await itemFor(client, reply, channel, { myNickname, namesById, inHurry: false });
        if (item) items.push(item);
    }
    const newestReply = parents.reduce((newest, parent) =>
        (Number(parent.latest_reply) > Number(newest) ? parent.latest_reply : newest), repliesSince);
    return { replies: items, newestReply };
}

// Returns items oldest-first. With `oldest` set, Slack answers from the old end of
// the range, so messages[0] is the high-water mark and a burst wider than one page
// is carried across polls rather than dropped.
export async function pollChannel(client, channel, { since, repliesSince = null, myNickname, deadline = null }) {
    const items = [];
    let newest = since;
    let cursor = '';

    for (let page = 0; page < MAX_PAGES; page++) {
        // Out of time. What has been read is returned and the cursor moves with
        // it, so the next poll starts where this one stopped rather than repeating
        // the work. A partial answer now beats a whole one after the prompt.
        if (deadline && Date.now() > deadline) break;

        const history = await client.form('conversations.history', {
            channel: channel.id,
            limit: PAGE_LIMIT,
            // Without this Slack returns no metadata at all, so every message
            // another agent signed arrives looking like a bare bot post and is
            // dropped two lines below. Humans were unaffected, which is why the
            // log looked healthy while no peer was ever seen.
            include_all_metadata: true,
            ...(since ? { oldest: since } : {}),
            ...(cursor ? { cursor } : {}),
        });
        if (!history.ok) return { ok: false, reason: history.error, items: [] };

        // Every human name in the page, resolved in one go before any item is
        // built. Doing it inside the loop meant one file read per message to
        // answer the same question about the same twenty people.
        const namesById = await namesInPage(client, history.messages);

        for (const message of history.messages.slice().reverse()) {
            if (!isKept(message)) continue;
            if (!newest || Number(message.ts) > Number(newest)) newest = message.ts;

            const item = await itemFor(client, message, channel, { myNickname, namesById, inHurry: Boolean(deadline) });
            if (item) items.push(item);
        }

        cursor = history.response_metadata?.next_cursor ?? '';
        if (!history.has_more || !cursor) break;
    }

    // Only the syncer reads threads: a deadline means somebody is waiting, and a
    // first poll has no cursor to measure "new" against.
    let newestReply = null;
    if (!deadline && since) {
        const thread = await threadReplies(client, channel, { repliesSince: repliesSince ?? since, myNickname });
        const seen = new Set(items.map((item) => item.ts)); // a broadcast reply is in both reads
        items.push(...thread.replies.filter((item) => !seen.has(item.ts)));
        items.sort((left, right) => Number(left.ts) - Number(right.ts));
        newestReply = thread.newestReply;
    }

    return { ok: true, items, newest, newestReply };
}
