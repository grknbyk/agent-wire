// The Slack side: one thin client, three read-only probes that setup and doctor
// both use, and the poll that turns channel history into local inbox items.
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';

import { paths, readJson, writeJson } from './config.mjs';
import { checkAuthorship } from './identity.mjs';
import { HUMAN_TEXT_CAP, METADATA_EVENT, fromSlackText, parseMessage } from './protocol.mjs';

const API = 'https://slack.com/api/';
const RATE_LIMITED = 429;
const DEFAULT_RETRY_SECONDS = 5;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

// conversations.* reject a JSON body and chat.postMessage needs one for metadata,
// so the client speaks both and the caller picks per method.
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

// --- probes: read-only, and the same three answer "is setup done" and "what
// broke". Each returns a verdict plus the reason, never a bare boolean, because
// a spinner that cannot say why it is still spinning is the worst dead-end.

export async function probeToken(client) {
    const result = await client.form('auth.test', {});
    if (result.ok) return { ok: true, teamId: result.team_id, botUserId: result.user_id, team: result.team };
    return { ok: false, reason: result.error };
}

export async function probeChannel(client, name) {
    const wanted = String(name).replace(/^#/, '').toLowerCase();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.form('conversations.list', {
            types: 'public_channel,private_channel',
            exclude_archived: true,
            limit: 200,
            cursor,
        });
        if (!result.ok) return { ok: false, reason: result.error };

        const found = result.channels.find((channel) => channel.name.toLowerCase() === wanted);
        if (found) return { ok: true, id: found.id, name: found.name, isMember: found.is_member, isPrivate: found.is_private };

        cursor = result.response_metadata?.next_cursor ?? '';
        if (!cursor) return { ok: false, reason: 'channel_not_found' };
    }
    return { ok: false, reason: 'channel_not_found' };
}

// A public channel we can create and join ourselves, which removes the invite
// step entirely. A private one has to be created by a human and the bot invited,
// because no scope lets an app add itself to a private conversation.
export async function ensureChannel(client, name) {
    const existing = await probeChannel(client, name);
    if (existing.ok && existing.isMember) return existing;

    if (existing.ok && !existing.isPrivate) {
        const joined = await client.form('conversations.join', { channel: existing.id });
        if (!joined.ok) return { ok: false, reason: joined.error, id: existing.id };
        return { ...existing, isMember: true };
    }

    if (existing.ok) return { ok: false, reason: 'needs_invite', id: existing.id, name: existing.name };

    if (existing.reason !== 'channel_not_found') return existing;

    const created = await client.form('conversations.create', { name: String(name).replace(/^#/, ''), is_private: false });
    if (!created.ok) return { ok: false, reason: created.error };
    return { ok: true, id: created.channel.id, name: created.channel.name, isMember: true, isPrivate: false, created: true };
}

// --- sending

// `rendered` is the whole visible message — header line plus body — because that
// is what a human scrolling the channel reads. The signature and routing fields
// travel in metadata, which Slack never renders.
export async function postMessage(client, { channel, rendered, signature, publicKey, from, to, conv, hop }) {
    const result = await client.json('chat.postMessage', {
        channel,
        text: rendered,
        metadata: {
            event_type: METADATA_EVENT,
            event_payload: { v: 1, from, to, conv, hop, sig: signature, key: publicKey },
        },
    });
    if (result.ok) return { ok: true, ts: result.ts };
    return { ok: false, reason: result.error };
}

export async function uploadFile(client, { channel, path, comment }) {
    const bytes = readFileSync(path);
    const name = basename(path);
    const slot = await client.form('files.getUploadURLExternal', { filename: name, length: bytes.length });
    if (!slot.ok) return { ok: false, reason: slot.error };

    const upload = await fetch(slot.upload_url, { method: 'POST', body: bytes });
    if (!upload.ok) return { ok: false, reason: `upload_failed_http_${upload.status}` };

    const done = await client.form('files.completeUploadExternal', {
        files: JSON.stringify([{ id: slot.file_id, title: name }]),
        channel_id: channel,
        initial_comment: comment,
    });
    return done.ok ? { ok: true } : { ok: false, reason: done.error };
}

// --- polling

async function resolveUserName(client, userId) {
    const cached = readJson(paths.users, {});
    if (cached[userId]) return cached[userId];

    const result = await client.form('users.info', { user: userId });
    const name = result.ok ? (result.user.profile?.display_name || result.user.real_name || userId) : userId;
    writeJson(paths.users, { ...cached, [userId]: name });
    return name;
}

// A human typing in the channel is worth seeing but is never a directive: it is
// capped, marked, and handed to the agent as data. Slack's own user id is the
// identity here — that field is not writable by the person typing.
async function humanItem(client, message, channel) {
    const typed = fromSlackText(message.text ?? '').trim();
    if (!typed) return null;

    const text = typed.length > HUMAN_TEXT_CAP
        ? `${typed.slice(0, HUMAN_TEXT_CAP)}\n... ${typed.length - HUMAN_TEXT_CAP} more characters truncated`
        : typed;
    return {
        ts: message.ts,
        at: new Date(Number(message.ts) * 1000).toISOString(),
        channel: channel.name,
        channelId: channel.id,
        from: await resolveUserName(client, message.user),
        userId: message.user,
        kind: 'human',
        authorship: 'slack-verified',
        hop: 1,
        text,
    };
}

function agentItem(message, channel, payload) {
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
        text,
    });

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

        for (const message of history.messages.slice().reverse()) {
            if (message.subtype) continue;
            if (!newest || Number(message.ts) > Number(newest)) newest = message.ts;

            const payload = message.metadata?.event_type === METADATA_EVENT ? message.metadata.event_payload : null;
            if (payload) {
                if (payload.from === myNickname) continue; // our own post, already in our log
                items.push(agentItem(message, channel, payload));
                continue;
            }
            if (message.bot_id) continue; // another app, or one of our own header-only posts

            const human = await humanItem(client, message, channel);
            if (human) items.push(human);
        }

        cursor = history.response_metadata?.next_cursor ?? '';
        if (!history.has_more || !cursor) break;
    }

    return { ok: true, items, newest };
}
