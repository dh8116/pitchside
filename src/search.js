// Web search for providers that have no built-in search tool (Gemini, Groq, Ollama, any
// OpenAI-compatible endpoint). Claude and the Meta Model API search natively instead.
//
// Backends, first one that is configured wins:
//   BRAVE_API_KEY   https://brave.com/search/api   (free tier)
//   TAVILY_API_KEY  https://tavily.com             (free tier)
//   neither         DuckDuckGo's HTML page, no key (best effort; may be rate-limited)
// Offline or blocked: the tool answers "search unavailable" and the coach carries on from what it knows.

const UA = 'Mozilla/5.0 (compatible; Pitchside)';
export const SEARCH_UNAVAILABLE = 'Search is unavailable right now (offline or blocked). Say you could not check, and answer from what you already know.';

const clean = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export function parseDuckDuckGo(html, limit = 5) {
  const out = [];
  // One block per result: from one result link up to the next.
  const blocks = html.split(/(?=<a[^>]*class="[^"]*result__a)/).filter((b) => /^<a[^>]*result__a/.test(b));
  for (const block of blocks) {
    if (out.length >= limit) break;
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let url = link[1].replace(/&amp;/g, '&');
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    if (/^https?:\/\//.test(url)) out.push({ title: clean(link[2]), url, snippet: clean(snippet?.[1] ?? '') });
  }
  return out;
}

function format(results) {
  if (!results.length) return 'No results found.';
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}

/** Returns async (query) => text. Never throws: failures come back as a message the model can read. */
export function createSearch({ env = {}, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const signal = () => AbortSignal.timeout(timeoutMs);
  async function run(query) {
    if (env.BRAVE_API_KEY) {
      const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_API_KEY }, signal: signal(),
      });
      if (!res.ok) throw new Error(`brave ${res.status}`);
      const data = await res.json();
      return (data.web?.results ?? []).slice(0, 5).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.description) }));
    }
    if (env.TAVILY_API_KEY) {
      const res = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: 5 }), signal: signal(),
      });
      if (!res.ok) throw new Error(`tavily ${res.status}`);
      const data = await res.json();
      return (data.results ?? []).slice(0, 5).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.content).slice(0, 300) }));
    }
    const res = await fetchImpl('https://html.duckduckgo.com/html/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ q: query }).toString(), signal: signal(),
    });
    if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
    return parseDuckDuckGo(await res.text());
  }
  return async function search(query) {
    const q = String(query ?? '').trim().slice(0, 300);
    if (!q) return 'No query given.';
    try { return format(await run(q)); } catch { return SEARCH_UNAVAILABLE; }
  };
}
