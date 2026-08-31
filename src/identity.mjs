// Every agent in a workspace shares one bot token, so Slack's own bot_id proves
// only "agent-wire posted this" — not which agent did. The header line is plain
// text anyone in the channel can type, so it cannot carry identity either.
// Each install therefore signs what it sends with its own Ed25519 key and
// publishes the public half alongside the message. A nickname is bound to the
// first key seen using it (trust on first use); a later message claiming that
// nickname with a different key is reported, not believed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { paths, readJson, writeJson } from './config.mjs';

const DER_PRIVATE = { type: 'pkcs8', format: 'der' };
const DER_PUBLIC = { type: 'spki', format: 'der' };

export function generateKeypair() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privateKey: privateKey.export(DER_PRIVATE).toString('base64'),
        publicKey: publicKey.export(DER_PUBLIC).toString('base64'),
    };
}

// Signed over the fields a forger would want to change: who sent it, who it is
// for, which channel it belongs to, and where it sits in a reply chain. Channel
// is included so a signed message cannot be replayed into a different channel.
export const signingPayload = ({ channel, from, to, conv, hop, text }) =>
    Buffer.from(`agent-wire/v1\n${channel}\n${from}\n${to}\n${conv}\n${hop}\n${text}`, 'utf8');

export function signMessage(privateKeyBase64, fields) {
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), ...DER_PRIVATE });
    return sign(null, signingPayload(fields), privateKey).toString('base64');
}

function verifySignature(publicKeyBase64, signature, fields) {
    try {
        const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), ...DER_PUBLIC });
        return verify(null, signingPayload(fields), publicKey, Buffer.from(signature, 'base64'));
    } catch {
        // A malformed key or signature is a failed verification, not a crash: the
        // bytes came from a Slack message and anyone in the channel can shape them.
        return false;
    }
}

const loadPeers = () => readJson(paths.peers, {});

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
    .map(([name, peer]) => ({ name, firstSeen: peer.firstSeen, fingerprint: peer.publicKey.slice(0, 12) }));
