// Is this machine online? Learned from real traffic (a cloud model or a post failing with a network
// error flags "offline"; a cloud call succeeding clears it) plus a cheap cached probe for when nothing
// else has run. Any HTTP answer, even an error status, means online; only "no answer at all" is offline.

const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** True for "couldn't reach the server" failures (not for HTTP error statuses). */
export function isNetworkError(err) {
  if (!err || err.status) return false;
  const code = err.cause?.code ?? err.code;
  return NET_CODES.has(code) || err.name === 'TimeoutError' || (err.name === 'TypeError' && /fetch failed|network/i.test(err.message ?? ''));
}

const DEFAULT_CHECK_URLS = ['https://www.cloudflare.com/cdn-cgi/trace', 'https://www.google.com/generate_204', 'https://bsky.social/xrpc/_health'];

export function createConnectivity({ checkUrls = DEFAULT_CHECK_URLS, fetchImpl = fetch, ttlMs = 10_000, timeoutMs = 4000, now = () => Date.now() } = {}) {
  let offline = false;
  let checkedAt = -Infinity;
  let inflight = null;

  const set = (value) => { offline = value; checkedAt = now(); };

  async function probe() {
    try {
      // Online if any one of the hosts answers, so one blocked host can't read as "offline".
      await Promise.any(checkUrls.map((url) => fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })));
      set(false);
    } catch {
      set(true);
    }
  }

  return {
    /** Last known state, no network call. */
    get offline() { return offline; },
    /** Offline as of the last ttlMs: used to skip cloud models without retrying them on every message. */
    recentlyOffline() { return offline && now() - checkedAt < ttlMs; },
    markOffline() { set(true); },
    markOnline() { set(false); },
    /** Resolves true when online. Re-probes only when the last answer is older than ttlMs. */
    async check() {
      if (now() - checkedAt >= ttlMs) {
        inflight ??= probe().finally(() => { inflight = null; });
        await inflight;
      }
      return !offline;
    },
  };
}
