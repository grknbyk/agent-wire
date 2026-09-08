// Every agent in a workspace shares one bot token, so Slack's own bot_id proves
// only "agent-wire posted this" — not which agent did. The header line is plain
// text anyone in the channel can type, so it cannot carry identity either.
// Each install therefore signs what it sends with its own Ed25519 key and
// publishes the public half alongside the message. A nickname is bound to the
// first key seen using it (trust on first use); a later message claiming that
// nickname with a different key is reported, not believed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { paths, readJsonCached, writeJson } from './config.mjs';

// A public key is 44 base64 characters. The prefix is what a human compares out
// loud when two agents disagree about who somebody is, so it is one decision and
// it is made once rather than at each of the four places that print it.
export const FINGERPRINT_CHARS = 12;

const DER_PRIVATE = { type: 'pkcs8', format: 'der' };
const DER_PUBLIC = { type: 'spki', format: 'der' };

// Parsing DER into a key object costs more than the Ed25519 check that follows
// it, and one poll verifies a page of messages against the same handful of keys.
// The object is derived from the bytes alone, so keying the cache on those bytes
// verifies exactly what it verified before.
//
// ponytail: bounded by clearing, not by evicting the oldest. The keys come out of
// a Slack channel, so an unbounded map is somebody else's memory budget; an LRU
// would be the upgrade if a workspace ever holds more agents than this.
const KEY_CACHE_MAX = 512;
const keyObjects = new Map();

function cachedKey(material, build) {
    const cached = keyObjects.get(material);
    if (cached) return cached;

    if (keyObjects.size >= KEY_CACHE_MAX) keyObjects.clear();
    const key = build();
    keyObjects.set(material, key);
    return key;
}

export function generateKeypair() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privateKey: privateKey.export(DER_PRIVATE).toString('base64'),
        publicKey: publicKey.export(DER_PUBLIC).toString('base64'),
    };
}

// Signed over the fields a forger would want to change: who sent it, who it is
// for, which channel it belongs to, where it sits in a reply chain, and which
// file it points at. Channel is included so a signed message cannot be replayed
// into a different channel; file is included so a valid signature cannot be
// re-attached to somebody else's upload.
export const signingPayload = ({ channel, from, to, conv, hop, file = '', text }) =>
    Buffer.from(`agent-wire/v2\n${channel}\n${from}\n${to}\n${conv}\n${hop}\n${file}\n${text}`, 'utf8');

export function signMessage(privateKeyBase64, fields) {
    const privateKey = cachedKey(privateKeyBase64, () => createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), ...DER_PRIVATE }));
    return sign(null, signingPayload(fields), privateKey).toString('base64');
}

function verifySignature(publicKeyBase64, signature, fields) {
    try {
        const publicKey = cachedKey(publicKeyBase64, () => createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), ...DER_PUBLIC }));
        return verify(null, signingPayload(fields), publicKey, Buffer.from(signature, 'base64'));
    } catch {
        // A malformed key or signature is a failed verification, not a crash: the
        // bytes came from a Slack message and anyone in the channel can shape them.
        return false;
    }
}

const loadPeers = () => readJsonCached(paths.peers, {});

// Verdicts, in the order they are decided:
//   "signed"    — signature valid and the key matches the one pinned to this name
//   "new"       — signature valid, first time this name appears, key now pinned
//   "impostor"  — signature valid but the name is pinned to a DIFFERENT key
//   "unsigned"  — no signature, or the signature does not verify
export function checkAuthorship({ from, publicKey, signature, ...fields }) {
    if (!publicKey || !signature) return { verdict: 'unsigned' };
    if (!verifySignature(publicKey, signature, { from, ...fields })) return { verdict: 'unsigned' };

    const peers = loadPeers();
    const pinned = peers[from];
    if (pinned && pinned.publicKey !== publicKey) return { verdict: 'impostor', pinnedSince: pinned.firstSeen };
    if (pinned) return { verdict: 'signed' };

    peers[from] = { publicKey, firstSeen: new Date().toISOString() };
    writeJson(paths.peers, peers);
    return { verdict: 'new' };
}

export const forgetPeer = (name) => {
    const peers = loadPeers();
    delete peers[name];
    writeJson(paths.peers, peers);
};

export const listPeers = () => Object.entries(loadPeers())
    .map(([name, peer]) => ({ name, firstSeen: peer.firstSeen, fingerprint: peer.publicKey.slice(0, FINGERPRINT_CHARS) }));
