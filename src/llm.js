// Model providers. The coach only needs `complete({ system, messages, webSearch })`
// returning the reply text, so any provider can sit behind it:
//   - Claude (Anthropic SDK) — best quality, supports web search
//   - Gemini / Groq — free tiers via their OpenAI-compatible chat endpoints
//   - Meta Model API — Muse Spark / Muse Wonder through Meta's Responses API, with native web search
//   - Ollama — a local model, no key and no internet needed (searching just reports "unavailable" offline)
// Several providers can be chained: on a rate limit or outage the next one answers.

import { createSearch } from './search.js';
import { isNetworkError } from './connectivity.js';

const MAX_PAUSE_CONTINUATIONS = 3;

// A local model on a laptop CPU reads a prompt at tens of tokens a second, so it gets a lighter request:
// the short system prompt, only recent history, a capped reply and one trimmed search round.
const LOCAL = { maxTokens: 700, historyMessages: 14, searchRounds: 1, toolChars: 1200 };
const PREFERRED_LOCAL = ['qwen2.5:3b', 'llama3.2:3b', 'llama3.2', 'qwen2.5:7b', 'llama3.1:8b', 'gemma2:2b', 'phi3'];

// Server-side refusal fallback: if the main Claude model declines, the API
// reruns the request on a fallback model it picks, inside the same call.
const CLAUDE_FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

export function anthropicLLM(client, { model = 'claude-opus-5' } = {}) {
  return {
    name: `claude (${model})`,
    supportsWebSearch: true,
    nativeSearch: true,
    async complete({ system, messages, webSearch, signal }) {
      const tools = webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : undefined;
      const convo = [...messages];
      let text = '';
      for (let i = 0; i <= MAX_PAUSE_CONTINUATIONS; i++) {
        const msg = await client.beta.messages.stream({
          ...CLAUDE_FALLBACK,
          model,
          max_tokens: 16000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          cache_control: { type: 'ephemeral' },
          system,
          tools,
          messages: convo,
        }, { signal }).finalMessage();

        for (const block of msg.content) if (block.type === 'text') text += block.text;
        if (msg.stop_reason === 'refusal') return `${text}\n\nI can't help with that one. Try me on a different angle.`;
        // A long web-search turn can pause; hand it back as-is so it can finish.
        if (msg.stop_reason !== 'pause_turn') break;
        convo.push({ role: 'assistant', content: msg.content });
      }
      return text;
    },
  };
}

export const FREE_PROVIDERS = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
};

// Meta Model API (https://dev.meta.ai/docs), OpenAI-compatible chat. Optional; set MODEL_API_KEY (or META_API_KEY).
// Text models: muse-spark-1.3, muse-spark-1.2, muse-wonder-1.0. The "-contributor" variants are cheaper but Meta may
// use prompts to improve its products, so they are never the default. Muse Image and SAM 3.1 aren't chat models.
export const META_PROVIDER = { baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3' };

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information: competitors, news, pricing, launches, anything recent. Returns titles, links and snippets.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
  },
};
const MAX_SEARCH_ROUNDS = 3;

/** Reads an OpenAI-style server-sent-events reply into the same shape a non-streaming reply has. */
async function collectStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = [];
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let delta;
    try { delta = JSON.parse(payload).choices?.[0]?.delta; } catch { return; }
    if (delta?.content) content += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      const call = (calls[tc.index ?? calls.length] ??= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) { take(buffer.slice(0, nl).trim()); buffer = buffer.slice(nl + 1); }
  }
  take(buffer.trim());
  return { choices: [{ message: { content, tool_calls: calls.length ? calls.filter(Boolean) : undefined } }] };
}

/** Keeps the most recent messages, starting on a user turn. */
function recent(messages, n) {
  const kept = messages.slice(-n);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

/**
 * Any OpenAI-compatible /chat/completions endpoint (Gemini, Groq, OpenRouter, a local Ollama…).
 * With `search` it offers a web_search function and runs up to three rounds of tool calls.
 * `local` marks a model running on this machine: it gets the light request described at LOCAL.
 */
export function openaiCompatibleLLM({ name, baseUrl, apiKey, model, local = false, maxTokens = local ? LOCAL.maxTokens : 4000, search = null, fetchImpl = fetch }) {
  let toolsRejected = false; // a model that can't do tool calls gets plain chat from then on
  const maxRounds = local ? LOCAL.searchRounds : MAX_SEARCH_ROUNDS;
  async function post(body, signal) {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      // A local model on a slow machine can take minutes to answer. Streaming sends the headers at once, so
      // fetch's five-minute wait-for-headers limit never trips; the pieces are put back together below.
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(local ? { stream: true } : {}), ...body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`${name} → ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
    }
    return local && res.body?.getReader ? collectStream(res) : res.json();
  }
  return {
    name: `${name} (${model})`,
    local,
    supportsWebSearch: Boolean(search),
    /** Loads the model into memory ahead of the first message (a cold local model takes a while). */
    async warm(system) {
      await post({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }], max_tokens: 1 }).catch(() => {});
    },
    async complete({ system, systemLite, messages, webSearch, signal }) {
      const sent = local ? recent(messages, LOCAL.historyMessages) : messages;
      const convo = [{ role: 'system', content: local && systemLite ? systemLite : system }, ...sent.map(({ role, content }) => ({ role, content }))];
      let useTools = Boolean(search && webSearch && !toolsRejected);
      for (let round = 0; ; round++) {
        let data;
        try {
          data = await post(useTools && round < maxRounds ? { messages: convo, tools: [SEARCH_TOOL] } : { messages: convo }, signal);
        } catch (err) {
          if (useTools && round === 0 && (err.status === 400 || err.status === 422)) { toolsRejected = true; useTools = false; continue; }
          throw err;
        }
        const msg = data.choices?.[0]?.message;
        const calls = msg?.tool_calls;
        if (useTools && calls?.length && round < maxRounds) {
          convo.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
          for (const call of calls) {
            let query = '';
            try { query = JSON.parse(call.function?.arguments || '{}').query; } catch {}
            const found = await search(query);
            convo.push({ role: 'tool', tool_call_id: call.id, content: local ? found.slice(0, LOCAL.toolChars) : found });
          }
          continue;
        }
        if (!msg?.content) throw Object.assign(new Error(`${name} returned no text`), { status: 502 });
        return msg.content;
      }
    },
  };
}

/**
 * Meta Model API (https://dev.meta.ai/docs) through its Responses endpoint, which is the one that carries
 * Meta's built-in web search ("search grounding"). Chat Completions has no search, so it isn't used here.
 */
export function metaLLM({ apiKey, baseUrl, model, fetchImpl = fetch }) {
  let searchRejected = false;
  const textOf = (data) => {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    return (data.output ?? []).filter((o) => o.type === 'message')
      .flatMap((o) => (o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text)).join('');
  };
  const sourcesOf = (data) => {
    const urls = (data.output ?? []).filter((o) => o.type === 'message')
      .flatMap((o) => (o.content ?? []).flatMap((c) => (c.annotations ?? []).filter((a) => a.type === 'url_citation').map((a) => a.url)));
    return [...new Set(urls)].slice(0, 3);
  };
  return {
    name: `meta (${model})`,
    supportsWebSearch: true,
    nativeSearch: true,
    async complete({ system, messages, webSearch, signal }) {
      const input = [{ role: 'developer', content: system }, ...messages.map(({ role, content }) => ({ role, content }))];
      for (const withSearch of webSearch && !searchRejected ? [true, false] : [false]) {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, input, ...(withSearch ? { tools: [{ type: 'web_search' }] } : {}) }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if (withSearch && (res.status === 400 || res.status === 422)) { searchRejected = true; continue; }
          throw Object.assign(new Error(`meta → ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
        }
        const data = await res.json();
        const text = textOf(data);
        if (!text) throw Object.assign(new Error('meta returned no text'), { status: 502 });
        const searched = (data.output ?? []).some((o) => o.type === 'web_search_call');
        const sources = searched ? sourcesOf(data) : [];
        return sources.length ? `${text}\n\nSources: ${sources.join(' ')}` : text;
      }
    },
  };
}

const retryable = (err) => !err.status || err.status === 408 || err.status === 429 || err.status >= 500;

/**
 * Tries providers in order; moves on when one is rate-limited or down. With `connectivity`, a cloud
 * provider that can't be reached marks the app offline: a local model answers instead (without web
 * search, which can't work offline) and cloud providers are skipped for a few seconds, then tried again.
 */
export function chainLLM(providers, { log = console, connectivity = null } = {}) {
  if (providers.length === 1 && !connectivity) return providers[0];
  const hasLocal = providers.some((p) => p.local);
  return {
    name: providers.map((p) => p.name).join(' → '),
    supportsWebSearch: providers[0].supportsWebSearch,
    nativeSearch: Boolean(providers[0].nativeSearch),
    warm: (system) => Promise.all(providers.filter((p) => p.local && p.warm).map((p) => p.warm(system))),
    async complete(args) {
      const skipCloud = hasLocal && connectivity?.recentlyOffline();
      let lastErr;
      for (const [i, p] of providers.entries()) {
        if (skipCloud && !p.local) continue;
        try {
          const webSearch = args.webSearch && p.supportsWebSearch && !(p.local && connectivity?.offline);
          const text = await p.complete({ ...args, webSearch });
          if (!p.local) connectivity?.markOnline();
          return text;
        } catch (err) {
          lastErr = err;
          if (!p.local && isNetworkError(err)) connectivity?.markOffline();
          // The local model not answering says nothing about the internet, so say what is actually wrong.
          if (p.local && isNetworkError(err)) lastErr = Object.assign(new Error('the local model did not answer'), { status: 503, code: 'LOCAL_DOWN', cause: err });
          if (!retryable(err) || i === providers.length - 1) throw lastErr;
          log.warn?.(`${p.name} failed (${err.status ?? err.message}); trying ${providers[i + 1].name}`);
        }
      }
      throw lastErr;
    },
  };
}

/** Names of the models an Ollama server has installed, or [] if it isn't running. */
export async function listOllamaModels(baseUrl = 'http://localhost:11434', fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/(v1)?\/?$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return [];
    return ((await res.json()).models ?? []).map((m) => m.name).filter((n) => n && !/embed/i.test(n));
  } catch {
    return [];
  }
}

/** A small, fast model beats a big slow one for chat on a laptop: prefer known good ones, else the first installed. */
export const pickLocalModel = (names) => PREFERRED_LOCAL.map((p) => names.find((n) => n === p || n.startsWith(`${p}:`))).find(Boolean) ?? names[0] ?? null;

/** A local Ollama provider that finds its model when first used, so a model installed later is picked up. */
function autoOllama({ baseUrl, search, fetchImpl }) {
  let inner = null;
  async function find() {
    if (inner) return inner;
    const model = pickLocalModel(await listOllamaModels(baseUrl, fetchImpl));
    if (!model) return null;
    return (inner = openaiCompatibleLLM({ name: 'ollama', baseUrl: `${baseUrl.replace(/\/(v1)?\/?$/, '')}/v1`, model, apiKey: 'ollama', local: true, search, fetchImpl }));
  }
  return {
    name: 'ollama (auto)',
    local: true,
    supportsWebSearch: Boolean(search),
    async complete(args) {
      const llm = await find();
      if (!llm) throw Object.assign(new Error('no local model found; install Ollama and run: ollama pull qwen2.5:3b'), { status: 503, code: 'NO_LOCAL_MODEL' });
      return llm.complete(args);
    },
    async warm(system) { await (await find())?.warm(system); },
  };
}

/**
 * Builds the provider chain from environment variables. Order: Meta Model API (Muse), Claude,
 * Gemini, Groq, a local Ollama model, then a custom endpoint. LLM_PROVIDERS=ollama,meta overrides it.
 */
export function llmFromEnv(env, { createAnthropicClient, fetchImpl, log, connectivity = null, autoLocal = false } = {}) {
  const search = createSearch({ env, fetchImpl });
  const compat = (name, base, model, apiKey, local = false) => () => openaiCompatibleLLM({ name, baseUrl: base, model, apiKey, local, search, fetchImpl });
  const metaKey = env.MODEL_API_KEY || env.META_API_KEY;
  const available = {
    meta: metaKey
      ? () => metaLLM({ apiKey: metaKey, baseUrl: env.META_API_BASE || META_PROVIDER.baseUrl, model: env.META_MODEL || META_PROVIDER.model, fetchImpl })
      : null,
    claude: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
      ? () => anthropicLLM(createAnthropicClient(), { model: env.PITCHSIDE_MODEL || 'claude-opus-5' })
      : null,
    gemini: env.GEMINI_API_KEY ? compat('gemini', FREE_PROVIDERS.gemini.baseUrl, env.GEMINI_MODEL || FREE_PROVIDERS.gemini.model, env.GEMINI_API_KEY) : null,
    groq: env.GROQ_API_KEY ? compat('groq', FREE_PROVIDERS.groq.baseUrl, env.GROQ_MODEL || FREE_PROVIDERS.groq.model, env.GROQ_API_KEY) : null,
    // A model running on this machine: no key, no internet. Searching just reports "unavailable" when offline.
    ollama: env.OLLAMA_MODEL ? compat('ollama', env.OLLAMA_BASE_URL || 'http://localhost:11434/v1', env.OLLAMA_MODEL, 'ollama', true) : null,
    custom: env.LLM_BASE_URL && env.LLM_MODEL ? compat('custom', env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY ?? '') : null,
  };
  const order = env.LLM_PROVIDERS
    ? env.LLM_PROVIDERS.split(',').map((x) => x.trim().toLowerCase())
    : ['meta', 'claude', 'gemini', 'groq', 'ollama', 'custom'];
  const providers = order.filter((n) => available[n]).map((n) => available[n]());
  // With any other provider set up, a local Ollama model (if one is installed) quietly backs it up for when
  // the internet drops. Skipped when LLM_PROVIDERS spells out the order.
  if (autoLocal && providers.length && !env.LLM_PROVIDERS && !available.ollama) {
    providers.push(autoOllama({ baseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434', search, fetchImpl }));
  }
  return providers.length ? chainLLM(providers, { log, connectivity }) : null;
}
