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
export const toSlackText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Slack rewrites a bare URL to <url> or <url|label>. Scheme-anchored on purpose:
// stripping every <...> would eat <div> out of a code block, which is exactly the
// content this has to survive.
const unlinkify = (text) => text.replace(/<((?:https?:\/\/|mailto:)[^|>]+)(\|[^>]*)?>/g, '$1');

export const fromSlackText = (text) => unlinkify(String(text))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A short handle printed at the right edge of the header line, so a human
// scrolling the channel can say "read wms-agents@k7m2pq" instead of pasting a
// timestamp. Like the rest of the header it is DECORATION: unsigned, and anyone
// in the channel can type one. It names a message, it never proves anything.
//
// The alphabet drops i l o 0 1, the pair a person retypes wrong.
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const REF_LENGTH = 6;

export const mintRef = () => Array.from(
    randomBytes(REF_LENGTH),
    (byte) => REF_ALPHABET[byte % REF_ALPHABET.length],
).join('');

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// A terminal draws an emoji two columns wide and a box character one, so counting
// characters misaligns any row holding an emoji nickname. Count columns instead.
const WIDE = /^[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const ZERO = /^[\u0300-\u036f\u200b-\u200d\ufe00-\ufe0f]/;

export function displayWidth(text) {
    let columns = 0;
    for (const { segment } of graphemes.segment(String(text))) {
        if (ZERO.test(segment)) continue;
        columns += (WIDE.test(segment) || /\p{Extended_Pictographic}/u.test(segment)) ? 2 : 1;
    }
    return columns;
}

// The handle sits at a fixed column so a scrolled channel has one straight edge to
// read down. Slack's font is proportional, so this is an approximation — but the
// header is short and mostly latin, and approximate beats ragged.
//
// A long nickname pushes past the column rather than being cut. Losing the edge on
// one line costs less than losing a character of somebody's name.
export const HEADER_WIDTH = 60;

// @ is the character a person types to call an agent, so it means agent here too
// and one name carries one meaning in both places. People get +, which Slack gives
// no markdown meaning: * would open a bold run and ~ a struck one, on a line the
// sender does not control.
//
// One name often belongs to both, the agent "sinan" and the colleague Sinan, and
// saying which one a message went to is the whole point of the marker.
//
// Only the recipient is marked. Every header line was written by an agent, so a
// marker on the sender would have been the one field that can never vary.
//
// A name nobody has placed stays bare. Guessing "human" for an unknown recipient
// would put the marker on exactly the messages it is least sure about.
const RECIPIENT_MARK = { agent: '@', human: '+' };

export const addressLine = ({ from, to, toKind }) =>
    `${from} => ${to === 'all' ? 'all' : `${RECIPIENT_MARK[toKind] ?? ''}${to}`}`;

// A mark set as ":fire:" is six characters here and one emoji in Slack, so
// measuring the string overshot the padding by four columns on every line this
// agent sent. Slack is the only place this header is read, so Slack's width wins.
const SHORTCODE = /^:[a-z0-9_+-]+:$/i;
const markWidth = (mark) => (SHORTCODE.test(mark) ? 2 : displayWidth(mark));

export function formatMessage({ mark, from, to, toKind, text, ref, channel }) {
    const left = `${mark ? `${mark} ` : ''}${addressLine({ from, to, toKind })}`;
    if (!ref) return `${left}\n${toSlackText(text)}\n`;

    // Shipped once without this: a call site forgot the channel, the handle went out
    // bare, and every test still passed because they all called this directly.
    if (!channel) throw new TypeError(`formatMessage: ref ${ref} with no channel to put in front of it`);

    const handle = `${channel}@${ref}`;
    const drawn = mark ? markWidth(mark) + 1 + displayWidth(addressLine({ from, to, toKind })) : displayWidth(left);
    const gap = Math.max(1, HEADER_WIDTH - drawn - handle.length);
    return `${left}${' '.repeat(gap)}${handle}\n${toSlackText(text)}\n`;
}

// A sender is never marked now, but 0.13.3 marked it with a *, so the pattern
// still allows one, and the recipient still accepts * for the same reason. Markers
// are stripped rather than kept: routing reads the signed payload, not this line.
const HEADER = /^(?:(?<mark>\S+)\s+)?\*?(?<from>[^\s=*]+)\s*=>\s*[@*+]?(?<to>\S+?)(?:\s+(?<refChannel>[a-z0-9][\w.-]*)?@(?<ref>[a-z2-9]{4,12}))?$/;

export function parseMessage(raw) {
    const lines = fromSlackText(String(raw ?? '').replace(/\r\n/g, '\n')).trim().split('\n');
    const header = HEADER.exec((lines[0] ?? '').trim());
    if (!header) return null;

    const { mark, from, to, refChannel, ref } = header.groups;
    return {
        mark: mark ?? '',
        from,
        to,
        refChannel: refChannel ?? '',
        ref: ref ?? '',
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
    for (const prefix of ['@', '*']) {
        const tag = `${prefix}${myNickname.toLowerCase()}`;
        for (let at = text.indexOf(tag); at !== -1; at = text.indexOf(tag, at + 1)) {
            const after = text[at + tag.length];
            if (after === undefined || !CONTINUES.test(after)) return 'you';
        }
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
        ...(item.ref ? [`ref=${item.channel ?? ''}@${item.ref}`] : []),
        `addressed=${addressee(item, myNickname)}`,
        `channel=${item.channel}`,
        `ts=${item.ts}`,
        `hop=${item.hop ?? 1}`,
        ...(attachments ? [`files=${attachments}`] : []),
    ].join(' ');
    return `${fenceHeader}>>>\n${redactFence(item.text, nonce)}\n<<<END:${nonce}>>>`;
}
