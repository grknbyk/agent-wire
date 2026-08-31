// The Slack side: one thin client, the probes that setup and doctor both use, and
// the poll that turns channel history into local inbox items.
import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { paths, readJsonCached, writeJson } from './config.mjs';
import { checkAuthorship } from './identity.mjs';
import { HUMAN_TEXT_CAP, METADATA_EVENT, fromSlackText, parseMessage } from './protocol.mjs';

const API = 'https://slack.com/api/';
const RATE_LIMITED = 429;
const DEFAULT_RETRY_SECONDS = 5;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const MEMBER_LIMIT = 200;
const FILE_SHARE = 'file_share';

// Long enough to keep a real document name recognisable, short enough that the
// Slack file id in front of it still fits a filesystem path.
const NAME_MAX_CHARS = 80;

// Slack serves file bytes over plain HTTP, so an oversized attachment is an
// oversized write to the user's disk. Past this the file stays in Slack and the
// message says why it was left there.
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

// conversations.* reject a JSON body and chat.postMessage needs one for metadata,
// so the client speaks both and the caller picks per method. The token rides along
// because downloading a file is a plain fetch, not an API call.
export function slackClient(token) {
    const request = async (method, init) => {
        const response = await fetch(API + method, {
            ...init,
            headers: { authorization: `Bearer ${token}`, ...init.headers },
        });
        if (response.status !== RATE_LIMITED) return response.json();

        const wait = Number(response.headers.get('retry-after') || DEFAULT_RETRY_SECONDS);
        await new Promise((done) => setTimeout(done, wait * 1000));
        return request(method, init);
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
// access control, and it is a human who types it.
export async function probeChannel(client, name) {
    const wanted = String(name).replace(/^#/, '').toLowerCase();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.form('users.conversations', {
            types: 'public_channel',
            exclude_archived: true,
            limit: MEMBER_LIMIT,
            cursor,
        });
        if (!result.ok) return { ok: false, reason: result.error };

        const found = result.channels.find((channel) => channel.name.toLowerCase() === wanted);
        if (found) return { ok: true, id: found.id, name: found.name };

        cursor = result.response_metadata?.next_cursor ?? '';
        if (!cursor) return { ok: false, reason: 'needs_invite' };
    }
    return { ok: false, reason: 'needs_invite' };
}

// Everyone in one channel the bot was invited to. No workspace directory call
// exists anywhere in the package, so an invite is the only way a name reaches it.
export async function listMembers(client, channelId) {
    const result = await client.form('conversations.members', { channel: channelId, limit: MEMBER_LIMIT });
    if (!result.ok) return { ok: false, reason: result.error };

    return { ok: true, names: await resolveUserNames(client, result.members) };
}

// --- sending

// `rendered` is the whole visible message — header line plus body — because that
// is what a human scrolling the channel reads. The signature and routing fields
// travel in metadata, which Slack never renders.
export async function postMessage(client, { channel, rendered, signature, publicKey, from, to, conv, hop, file }) {
    const result = await client.json('chat.postMessage', {
        channel,
        text: rendered,
        metadata: {
            event_type: METADATA_EVENT,
            event_payload: { v: 2, from, to, conv, hop, file: file ?? '', sig: signature, key: publicKey },
        },
    });
    if (result.ok) return { ok: true, ts: result.ts };
    return { ok: false, reason: result.error };
}

// No initial_comment on purpose. files.completeUploadExternal carries no metadata
// field, so a file posted with its own comment arrives unsigned and cannot be
// attributed. The caller posts a signed message naming this file id instead.
export async function uploadFile(client, { channel, path }) {
    const bytes = readFileSync(path);
    const name = basename(path);
    const slot = await client.form('files.getUploadURLExternal', { filename: name, length: bytes.length });
    if (!slot.ok) return { ok: false, reason: slot.error };

    const upload = await fetch(slot.upload_url, { method: 'POST', body: bytes });
    if (!upload.ok) return { ok: false, reason: `upload_failed_http_${upload.status}` };

    const done = await client.form('files.completeUploadExternal', {
        files: JSON.stringify([{ id: slot.file_id, title: name }]),
        channel_id: channel,
    });
    return done.ok ? { ok: true, fileId: slot.file_id, name } : { ok: false, reason: done.error };
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

    const response = await fetch(source, { headers: { authorization: `Bearer ${client.token}` } });
    if (!response.ok) {
        return { name: file.name, path: null, size: Number(file.size), skipped: `download failed, HTTP ${response.status}` };
    }

    mkdirSync(paths.files, { recursive: true });
    const localPath = join(paths.files, `${file.id}-${safeName(file.name)}`);
    writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
    return { name: file.name, path: localPath, size: Number(file.size) };
}

async function downloadAll(client, files) {
    const saved = [];
    for (const file of files ?? []) {
        const result = await downloadAttachment(client, file);
        if (result) saved.push(result);
    }
    return saved;
}

async function downloadById(client, fileId) {
    const info = await client.form('files.info', { file: fileId });
    if (!info.ok) return [];

    const saved = await downloadAttachment(client, info.file);
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

    const found = { ...known };
    for (const userId of missing) {
        const result = await client.form('users.info', { user: userId });
        found[userId] = result.ok
            ? (result.user.profile?.display_name || result.user.real_name || userId)
            : userId;
    }
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

async function agentItem(client, message, channel, payload) {
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
    const isTrusted = authorship.verdict === 'signed' || authorship.verdict === 'new';
    const files = payload.file && isTrusted ? await downloadById(client, payload.file) : [];

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
        text,
        files,
    };
}

// Returns items oldest-first. With `oldest` set, Slack answers from the old end of
// the range, so messages[0] is the high-water mark and a burst wider than one page
// is carried across polls rather than dropped.
export async function pollChannel(client, channel, { since, myNickname }) {
    const items = [];
    let newest = since;
    let cursor = '';

    for (let page = 0; page < MAX_PAGES; page++) {
        const history = await client.form('conversations.history', {
            channel: channel.id,
            limit: PAGE_LIMIT,
            ...(since ? { oldest: since } : {}),
            ...(cursor ? { cursor } : {}),
        });
        if (!history.ok) return { ok: false, reason: history.error, items: [] };

        // Every human name in the page, resolved in one go before any item is
        // built. Doing it inside the loop meant one file read per message to
        // answer the same question about the same twenty people.
        const namesById = await namesInPage(client, history.messages);

        for (const message of history.messages.slice().reverse()) {
            // file_share is the one subtype carrying a real message. The rest are
            // joins, leaves and topic changes, and dropping them is the point.
            if (message.subtype && message.subtype !== FILE_SHARE) continue;
            if (!newest || Number(message.ts) > Number(newest)) newest = message.ts;

            const payload = message.metadata?.event_type === METADATA_EVENT ? message.metadata.event_payload : null;
            if (payload) {
                if (payload.from === myNickname) continue; // our own post, already in our log
                items.push(await agentItem(client, message, channel, payload));
                continue;
            }
            if (message.bot_id) continue; // another app, or the bare upload our own sidecar describes

            const human = await humanItem(client, message, channel, namesById);
            if (human) items.push(human);
        }

        cursor = history.response_metadata?.next_cursor ?? '';
        if (!history.has_more || !cursor) break;
    }

    return { ok: true, items, newest };
}
