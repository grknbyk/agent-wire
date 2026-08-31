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

export const formatMessage = ({ mark, from, to, text }) =>
    `${mark ? `${mark} ` : ''}${from} => ${to}\n${toSlackText(text)}\n`;

// Rejects "*" as a sender so a bold-wrapped line cannot file a message under "*".
const HEADER = /^(?:(\S+)\s+)?([^\s=*]+)\s*=>\s*(\S+)$/;

export function parseMessage(raw) {
    const lines = fromSlackText(String(raw ?? '').replace(/\r\n/g, '\n')).trim().split('\n');
    const header = HEADER.exec((lines[0] ?? '').trim());
    if (!header) return null;

    return { mark: header[1] ?? '', from: header[2], to: header[3], text: lines.slice(1).join('\n').trim() };
}

// Minted once per server process, never written to Slack and never logged, so its
// only home is the agent's own context. A payload can imitate the fence but cannot
// produce the marker that closes it.
export const mintNonce = () => randomBytes(12).toString('hex');

// Reflection is the one realistic way the nonce escapes — an agent quoting its own
// inbox back into a reply. Redacting it makes that a visible event instead of a
// silently broken fence.
const redactFence = (text, nonce) => String(text).split(nonce).join('[FENCE-ECHO REDACTED]');

export function renderEnvelope(nonce, item) {
    const fenceHeader = [
        `<<<WIRE:${nonce} UNTRUSTED`,
        `from=${item.from}`,
        `kind=${item.kind}`,
        `authorship=${item.authorship}`,
        `channel=${item.channel}`,
        `ts=${item.ts}`,
        `hop=${item.hop ?? 1}>>>`,
    ].join(' ');
    return `${fenceHeader}\n${redactFence(item.text, nonce)}\n<<<END:${nonce}>>>`;
}
