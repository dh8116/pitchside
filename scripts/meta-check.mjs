// Live check of your Meta Model API setup: `npm run meta:check`.
// Tries, in order: the key (/models), a Responses call, a Responses call with web search, and (with --voice) a
// Voice Transcribe call on one second of silence. Each step prints what happened in plain words and never the key.
import { pathToFileURL } from 'node:url';
import { cleanKey, keyProblem, probeKey, fingerprint } from '../src/keys.js';
import { metaLLM, META_PROVIDER } from '../src/llm.js';
import { metaTranscriber, VOICE_MODEL } from '../src/meta/voice.js';
import { encodeWav } from '../public/wav.js';

export async function metaCheck({ env = process.env, voice = false, fetchImpl = fetch, out = console.log } = {}) {
  const raw = env.MODEL_API_KEY || env.META_API_KEY || '';
  const { key, fixes } = cleanKey(raw);
  const baseUrl = env.META_API_BASE || META_PROVIDER.baseUrl;
  const model = env.META_MODEL || META_PROVIDER.model;
  const results = [];
  const step = (name, ok, note) => { results.push({ name, ok }); out(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `: ${note}` : ''}`); return ok; };

  if (!key) { step('key', false, 'MODEL_API_KEY is not set. Get one at https://dev.meta.ai and put it in .env'); return { ok: false, results }; }
  const problem = keyProblem('meta', key);
  step('key', !problem, `${fingerprint(key)}${fixes.length ? ` (fixed: ${fixes.join(', ')})` : ''}${problem ? ` looks wrong: ${problem}` : ''}`);

  const probe = await probeKey({ baseUrl, apiKey: key, fetchImpl });
  const words = { ok: 'accepted', rejected: 'rejected by Meta: wrong, revoked or from another account', billing: 'valid, but billing is not set up: https://dev.meta.ai/docs/pricing-rate-limits', limited: 'valid, but rate limited right now', unreachable: `could not reach ${baseUrl}`, error: `Meta answered ${probe.code}` };
  if (!step('Meta accepts the key', probe.status === 'ok' || probe.status === 'limited', words[probe.status])) return { ok: false, results };

  const llm = metaLLM({ apiKey: key, baseUrl, model, fetchImpl, reasoning: env.META_REASONING || undefined, maxOutputTokens: env.META_MAX_OUTPUT_TOKENS ? Number(env.META_MAX_OUTPUT_TOKENS) : undefined, searchContext: env.META_SEARCH_CONTEXT || undefined });
  const ask = async (name, prompt, opts = {}) => {
    const t = Date.now();
    try {
      const text = await llm.complete({ system: 'Answer in one short sentence.', messages: [{ role: 'user', content: prompt }], ...opts });
      return step(name, Boolean(String(text ?? '').trim()), `${model}, ${Date.now() - t} ms`);
    } catch (err) {
      return step(name, false, String(err.message).slice(0, 200));
    }
  };
  await ask('a reply from the model', 'Say hello to a football coach.');
  await ask('a reply with web search', 'What is the latest FIFA World Cup winner?', { webSearch: true });

  if (voice) {
    const silence = [new Float32Array(16000)];
    try {
      const t = await metaTranscriber({ apiKey: key, baseUrl, model: env.META_VOICE_MODEL || VOICE_MODEL, fetchImpl })(Buffer.from(encodeWav(silence, 16000)));
      step('Voice Transcribe', true, `${env.META_VOICE_MODEL || VOICE_MODEL}, ${t.ms} ms`);
    } catch (err) { step('Voice Transcribe', false, err.message); }
  }
  return { ok: results.every((r) => r.ok), results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.loadEnvFile?.('.env'); } catch {}
  const { ok } = await metaCheck({ voice: process.argv.includes('--voice') });
  process.exit(ok ? 0 : 1);
}
