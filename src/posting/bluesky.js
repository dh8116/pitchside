// Bluesky via the AT Protocol XRPC API. Use an app password
// (bsky.app → Settings → Privacy and security → App passwords), not your main one.
import { request } from '../channels/util.js';

const MAX_GRAPHEMES = 300;
const URL_RE = /https?:\/\/[^\s)]*[^\s).,!?:;]/g;

export const graphemeCount = (text) => [...new Intl.Segmenter().segment(text)].length;

/** Link facets so URLs are clickable. Bluesky indexes by UTF-8 byte offset. */
export function linkFacets(text) {
  const bytes = (s) => new TextEncoder().encode(s).length;
  return [...text.matchAll(URL_RE)].map((m) => {
    const byteStart = bytes(text.slice(0, m.index));
    return {
      index: { byteStart, byteEnd: byteStart + bytes(m[0]) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    };
  });
}

export function blueskyPoster({ handle, appPassword, service = 'https://bsky.social', fetchImpl = fetch, now = () => new Date() }) {
  const xrpc = (method) => `${service.replace(/\/$/, '')}/xrpc/${method}`;
  const json = { 'content-type': 'application/json' };
  return {
    name: 'Bluesky',
    async post(text) {
      if (graphemeCount(text) > MAX_GRAPHEMES) throw new Error(`Bluesky posts max out at ${MAX_GRAPHEMES} characters`);
      const session = await (await request(fetchImpl, xrpc('com.atproto.server.createSession'), {
        method: 'POST', headers: json, body: JSON.stringify({ identifier: handle, password: appPassword }),
      })).json();
      const facets = linkFacets(text);
      const res = await request(fetchImpl, xrpc('com.atproto.repo.createRecord'), {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${session.accessJwt}` },
        body: JSON.stringify({
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record: { $type: 'app.bsky.feed.post', text, createdAt: now().toISOString(), ...(facets.length ? { facets } : {}) },
        }),
      });
      const { uri } = await res.json();
      return { url: `https://bsky.app/profile/${session.handle ?? handle}/post/${uri.split('/').pop()}` };
    },
  };
}
