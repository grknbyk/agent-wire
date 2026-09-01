// The wire format is two parts that serve different readers. The header line is
// for the humans scrolling the channel: "<mark> <from> => <to>", one line, so a
// busy channel scans down the left edge by sender. The signature and routing
// fields ride in Slack's message metadata, which the UI never renders.
//
// The header is DECORATION. Anyone in the channel can type it, so nothing trusts
// it — identity comes from the signature (see identity.mjs). It stays because a
// message no human can follow is a message nobody will keep in their workspace.
import { randomBytes } from 'node:crypto';

export const METADATA_EVENT = 'agent_wire_message';

// Slack splits a message past ~4000 characters, and the tail arrives with no
// header, so the receiver drops half an answer while the sender is told it was
// delivered. Anything longer goes as a file instead.
export const TEXT_MAX = 3500;
export const HUMAN_TEXT_CAP = 1000;
export const MAX_HOPS = 8;

// Slack escapes these three on the way in, so they are escaped on the way out and
// restored on the way in. &amp; is decoded last: decoding it first would turn a
// literal "&amp;lt;" into "<".
export const toSlackText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Slack rewrites a bare URL to <url> or <url|label>. Scheme-anchored on purpose:
// stripping every <...> would eat <div> out of a code block, which is exactly the
// content this has to survive.
const unlinkify = (s) => s.replace(/<((?:https?:\/\/|mailto:)[^|>]+)(\|[^>]*)?>/g, '$1');

export const fromSlackText = (s) => unlinkify(String(s))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A short handle printed at the end of the header line, so a human scrolling the
// channel can say "read @k7m2pq" instead of pasting a timestamp. Like the rest of
// the header it is DECORATION: unsigned, and anyone in the channel can type one.
// It names a message, it never proves anything about it.
//
// The alphabet drops i l o 0 1, the pair a person retypes wrong.
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const REF_LENGTH = 6;

export const mintRef = () => Array.from(
    randomBytes(REF_LENGTH),
    (byte) => REF_ALPHABET[byte % REF_ALPHABET.length],
).join('');

export const formatMessage = ({ mark, from, to, text, ref }) =>
    `${mark ? `${mark} ` : ''}${from} => ${to}${ref ? ` @${ref}` : ''}\n${toSlackText(text)}\n`;

// Rejects "*" as a sender so a bold-wrapped line cannot file a message under "*".
const HEADER = /^(?:(\S+)\s+)?([^\s=*]+)\s*=>\s*(\S+?)(?:\s+@([a-z2-9]{4,12}))?$/;

export function parseMessage(raw) {
    const lines = fromSlackText(String(raw ?? '').replace(/\r\n/g, '\n')).trim().split('\n');
    const header = HEADER.exec((lines[0] ?? '').trim());
    if (!header) return null;

    return {
        mark: header[1] ?? '',
        from: header[2],
        to: header[3],
        ref: header[4] ?? '',
        text: lines.slice(1).join('\n').trim(),
    };
}

// Minted once per server process, never written to Slack and never logged, so its
// only home is the agent's own context. A payload can imitate the fence but cannot
// produce the marker that closes it.
export const mintNonce = () => randomBytes(12).toString('hex');

// Reflection is the one realistic way the nonce escapes — an agent quoting its own
// inbox back into a reply. Redacting it makes that a visible event instead of a
// silently broken fence.
const redactFence = (text, nonce) => String(text).split(nonce).join('[FENCE-ECHO REDACTED]');

// An attached file is named in the header, never in the body. The path is one of
// the few things here the receiver produced itself, and putting it inside the
// fence would file it under "data written by someone else" along with the text.
const attachmentNote = (files) => (files ?? [])
    .map((file) => (file.path ? file.path : `${file.name} — not downloaded, ${file.skipped}`))
    .join(' | ');

// A human typing in the channel reaches every agent in it, and every one of them
// answering the same question is the noise this exists to avoid. Slack has no
// mention for an agent — the nickname is plain text — so the header answers the
// question instead, and the handshake says to reply only when it says `you`.
//
// An agent's own `to` field is the answer for agent traffic. It is not a filter:
// everything still arrives, and everything is still readable by the humans.
// A nickname is plain text in Slack, not a mention, so this is a literal search
// rather than a regex — no escaping, and a nickname with a dot or a dash in it
// cannot turn into a pattern. `@grkn` must not match inside `@grknbyk`.
const CONTINUES = /[a-z0-9_-]/i;

export function addressee(item, myNickname) {
    if (!myNickname) return 'unknown';
    if (item.kind !== 'human') {
        if (item.to === myNickname) return 'you';
        return item.to === 'all' || !item.to ? 'all' : item.to;
    }

    const text = String(item.text).toLowerCase();
    const tag = `@${myNickname.toLowerCase()}`;
    for (let at = text.indexOf(tag); at !== -1; at = text.indexOf(tag, at + 1)) {
        const after = text[at + tag.length];
        if (after === undefined || !CONTINUES.test(after)) return 'you';
    }
    return 'nobody';
}

export function renderEnvelope(nonce, item, myNickname) {
    const attachments = attachmentNote(item.files);
    const fenceHeader = [
        `<<<WIRE:${nonce} UNTRUSTED`,
        `from=${item.from}`,
        `kind=${item.kind}`,
        `authorship=${item.authorship}`,
        ...(item.ref ? [`ref=@${item.ref}`] : []),
        `addressed=${addressee(item, myNickname)}`,
        `channel=${item.channel}`,
        `ts=${item.ts}`,
        `hop=${item.hop ?? 1}`,
        ...(attachments ? [`files=${attachments}`] : []),
    ].join(' ');
    return `${fenceHeader}>>>\n${redactFence(item.text, nonce)}\n<<<END:${nonce}>>>`;
}
