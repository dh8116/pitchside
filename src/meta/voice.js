// Meta Voice Transcribe (https://dev.meta.ai/docs/speech-to-text): speech to text through POST /v1/asr/transcribe.
// The endpoint takes multipart/form-data with a JSON "request" part and an "audio" part that must be a WAV file,
// mono 16-bit PCM at 16 kHz or 24 kHz, up to 10 minutes and 32 MB. The answer is JSON with a "transcript" field.
// Billing is per second of audio ($0.18 an hour at the time of writing), and the model has no request-rate limit.
import { metaError } from '../llm.js';

export const VOICE_MODEL = 'muse-voice-transcribe-1.0';
export const MAX_WAV_BYTES = 8_000_000; // about four minutes at 16 kHz: plenty for a message, far below Meta's own cap
const MAX_MS = 10 * 60_000;

const badAudio = (message) => Object.assign(new Error(message), { status: 400, code: 'BAD_AUDIO' });

/** Reads a WAV header. Returns { sampleRate, ms } or throws a BAD_AUDIO error saying what Meta would reject. */
export function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw badAudio('That is not a WAV file.');
  let pos = 12; let fmt = null; let dataBytes = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') { dataBytes = Math.min(size, buf.length - pos - 8); break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes === null) throw badAudio('That WAV file has no audio in it.');
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) throw badAudio('Meta needs mono 16-bit PCM audio.');
  if (fmt.sampleRate !== 16000 && fmt.sampleRate !== 24000) throw badAudio('Meta needs 16 kHz or 24 kHz audio.');
  const ms = Math.round((dataBytes / 2 / fmt.sampleRate) * 1000);
  if (ms > MAX_MS) throw badAudio('That recording is longer than 10 minutes.');
  return { sampleRate: fmt.sampleRate, ms };
}

/** Returns async (wavBuffer, { languageBias }) => { text, ms }. languageBias is a hint, e.g. ["English", "French"]. */
export function metaTranscriber({ apiKey, baseUrl, model = VOICE_MODEL, fetchImpl = fetch }) {
  return async function transcribe(wav, { languageBias } = {}) {
    const info = wavInfo(wav);
    const form = new FormData();
    const request = { model, audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', ...(languageBias?.length ? { languageBias } : {}) };
    form.append('request', new Blob([JSON.stringify(request)], { type: 'application/json' }), 'request.json');
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/asr/transcribe`, {
      method: 'POST', headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, body: form,
    });
    if (!res.ok) throw metaError(res.status, await res.text().catch(() => ''), res.headers);
    const data = await res.json();
    return { text: String(data.transcript ?? '').trim(), ms: data.audioDurationMs ?? info.ms };
  };
}
