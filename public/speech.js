// Turning chat bubbles into something worth saying out loud. Pure text in, text out, so the browser's voice
// bar and the phone-call channel (src/channels/voice.js) speak the same way and both can be tested in Node.

const PLATFORM = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };
const URL_RE = /https?:\/\/[^\s)]*[^\s).,!?:;]/g;

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'a link'; } };

/** One piece of text, cleaned for speech: no markdown, no "(source: …)" clutter, links as their site name. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/\((?:source|sources):[^)]*\)/gi, '')
    .replace(/\bSources?:\s*(?:https?:\/\/\S+\s*)+/gi, '')
    .replace(URL_RE, (u) => host(u))
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** All of a reply's bubbles as one spoken script. Post drafts are introduced as drafts, line by line. */
export function bubblesToSpeech(bubbles, { maxChars = 1200 } = {}) {
  const parts = [];
  for (const b of bubbles ?? []) {
    if (b.type === 'post') {
      const name = PLATFORM[b.platform] ?? b.platform;
      parts.push(`Here is a draft for ${name}. ${cleanForSpeech(b.text).replace(/\n+/g, '. ').replace(/\.\s*\./g, '.')}`);
    } else {
      const t = cleanForSpeech(b.text);
      if (t) parts.push(t);
    }
  }
  const script = parts.join('\n\n');
  if (script.length <= maxChars) return script;
  const cut = script.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n')) + 1 || maxChars).trim()} The rest is in your chat.`;
}

/** Sentence-sized pieces, because browsers cut off or stall on long utterances. */
export function speechChunks(text, size = 180) {
  const chunks = [];
  for (const para of String(text).split(/\n+/)) {
    let cur = '';
    for (const sentence of para.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
      if (cur && cur.length + sentence.length > size) { chunks.push(cur.trim()); cur = ''; }
      cur += sentence;
    }
    if (cur.trim()) chunks.push(cur.trim());
  }
  return chunks;
}

/** Whether a spoken phrase means "end the call". */
export const isGoodbye = (text) => /^\s*(?:ok(?:ay)?[, ]+)?(?:good\s?bye|bye(?:[- ]bye)?|that'?s all|that is all|hang up|end (?:the )?call|talk (?:to you )?later)[\s.!]*$/i.test(String(text));
