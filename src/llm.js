// Model providers. The coach only needs `complete({ system, messages, webSearch })`
// returning the reply text, so any provider can sit behind it:
//   - Claude (Anthropic SDK) — best quality, supports web search
//   - Gemini / Groq — free tiers via their OpenAI-compatible chat endpoints
//   - Meta Llama API (optional) — Meta's OpenAI-compatible endpoint for Llama models
// Several providers can be chained: on a rate limit or outage the next one answers.

const MAX_PAUSE_CONTINUATIONS = 3;

// Server-side refusal fallback: if the main Claude model declines, the API
// reruns the request on a fallback model it picks, inside the same call.
const CLAUDE_FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

export function anthropicLLM(client, { model = 'claude-opus-5' } = {}) {
  return {
    name: `claude (${model})`,
    supportsWebSearch: true,
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

// Meta's Llama API, through its OpenAI-compatible endpoint. Optional; set LLAMA_API_KEY.
export const META_PROVIDER = { baseUrl: 'https://api.llama.com/compat/v1', model: 'Llama-4-Maverick-17B-128E-Instruct-FP8' };

/** Any OpenAI-compatible /chat/completions endpoint (Gemini, Groq, OpenRouter, a local Ollama…). */
export function openaiCompatibleLLM({ name, baseUrl, apiKey, model, maxTokens = 4000, fetchImpl = fetch }) {
  return {
    name: `${name} (${model})`,
    supportsWebSearch: false,
    async complete({ system, messages, signal }) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, ...messages.map(({ role, content }) => ({ role, content }))],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`${name} → ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw Object.assign(new Error(`${name} returned no text`), { status: 502 });
      return text;
    },
  };
}

const retryable = (err) => !err.status || err.status === 408 || err.status === 429 || err.status >= 500;

/** Tries providers in order; moves on when one is rate-limited or down. */
export function chainLLM(providers, { log = console } = {}) {
  if (providers.length === 1) return providers[0];
  return {
    name: providers.map((p) => p.name).join(' → '),
    supportsWebSearch: providers[0].supportsWebSearch,
    async complete(args) {
      let lastErr;
      for (const [i, p] of providers.entries()) {
        try {
          return await p.complete({ ...args, webSearch: args.webSearch && p.supportsWebSearch });
        } catch (err) {
          lastErr = err;
          if (!retryable(err) || i === providers.length - 1) throw err;
          log.warn?.(`${p.name} failed (${err.status ?? err.message}); trying ${providers[i + 1].name}`);
        }
      }
      throw lastErr;
    },
  };
}

/**
 * Builds the provider chain from environment variables. Order: Claude (if a
 * key is set), then Gemini, Groq and Meta (Llama API), then a custom endpoint.
 * LLM_PROVIDERS=gemini,groq,meta overrides it.
 */
export function llmFromEnv(env, { createAnthropicClient, fetchImpl, log } = {}) {
  const available = {
    claude: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
      ? () => anthropicLLM(createAnthropicClient(), { model: env.PITCHSIDE_MODEL || 'claude-opus-5' })
      : null,
    gemini: env.GEMINI_API_KEY
      ? () => openaiCompatibleLLM({ name: 'gemini', ...FREE_PROVIDERS.gemini, model: env.GEMINI_MODEL || FREE_PROVIDERS.gemini.model, apiKey: env.GEMINI_API_KEY, fetchImpl })
      : null,
    groq: env.GROQ_API_KEY
      ? () => openaiCompatibleLLM({ name: 'groq', ...FREE_PROVIDERS.groq, model: env.GROQ_MODEL || FREE_PROVIDERS.groq.model, apiKey: env.GROQ_API_KEY, fetchImpl })
      : null,
    meta: env.LLAMA_API_KEY
      ? () => openaiCompatibleLLM({ name: 'meta', ...META_PROVIDER, baseUrl: env.LLAMA_BASE_URL || META_PROVIDER.baseUrl, model: env.LLAMA_MODEL || META_PROVIDER.model, apiKey: env.LLAMA_API_KEY, fetchImpl })
      : null,
    custom: env.LLM_BASE_URL && env.LLM_MODEL
      ? () => openaiCompatibleLLM({ name: 'custom', baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY ?? '', fetchImpl })
      : null,
  };
  const order = env.LLM_PROVIDERS
    ? env.LLM_PROVIDERS.split(',').map((s) => s.trim().toLowerCase())
    : ['claude', 'gemini', 'groq', 'meta', 'custom'];
  const providers = order.filter((n) => available[n]).map((n) => available[n]());
  return providers.length ? chainLLM(providers, { log }) : null;
}
