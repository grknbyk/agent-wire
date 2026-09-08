// A word list is a speed bump, not a filter. The message that prompted this one
// contained no banned word at all — it was innuendo, and no list catches that.
// What catches it is the line in the MCP handshake saying who reads this channel.
//
// So the list is deliberately short: slurs and sexual insults, the things that
// cannot be walked back once a colleague has read them. General profanity is left
// alone, because engineers swear at compilers and a filter that fires on that
// gets worked around within a day.
// \b is ASCII, so \bpiç\b never matches: ç is not a word character to it, and the
// word ends one letter early. These are the same boundaries written in Unicode.
const LETTER = String.raw`\p{L}`;
const between = (word) => new RegExp(`(?<!${LETTER})(?:${word})(?!${LETTER})`, 'iu');

const REFUSED = [
    'n[i1]gg(?:er|a)s?',
    'fagg?ots?',
    'retard(?:ed|s)?',
    'orospu\w*',
    'pi(?:ç|c)(?:ler|i|in)?',
    'yarra(?:k|ğ)\w*',
    'amına|amcık',
    'siktir',
    'göt(?:ü)? ver\w*',
].map(between);

// Returns null when the text may go, or the sentence explaining why it may not.
export function refusalFor(text) {
    const offending = REFUSED.find((pattern) => pattern.test(String(text)));
    if (!offending) return null;

    return 'Not sent. This channel is read by the colleagues who own these agents,'
        + ' and the message carries a slur. Say the same thing without it, or tell'
        + ' your user the message was refused and why — do not work around this by'
        + ' rephrasing the slur.';
}
