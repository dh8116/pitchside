import { timingSafeEqual } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** fetch that throws on non-2xx with the response body in the message. */
export async function request(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`${init?.method ?? 'GET'} ${new URL(url).host} → ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
  }
  return res;
}

/** Sends bubbles one by one with a short pause so they arrive in order, like texting. */
export async function sendInOrder(bubbles, sendOne, gapMs = 800) {
  for (let i = 0; i < bubbles.length; i++) {
    if (i) await sleep(gapMs);
    await sendOne(bubbles[i]);
  }
}

export const ok = (body = 'ok', headers = { 'content-type': 'text/plain' }) => ({ status: 200, headers, body, messages: [] });
export const deny = (status = 403) => ({ status, headers: { 'content-type': 'text/plain' }, body: 'forbidden', messages: [] });
