// X (Twitter) via the v2 API, signed with OAuth 1.0a user context.
// Keys: developer.x.com → your app → Keys and tokens (app needs Read and Write).
import { createHmac, randomBytes } from 'node:crypto';
import { request } from '../channels/util.js';

const TWEETS_URL = 'https://api.x.com/2/tweets';

// RFC 3986 percent-encoding, as OAuth 1.0a requires.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Authorization header for one request. JSON bodies are not part of the signature. */
export function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  params.oauth_signature = createHmac('sha1', `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.keys(params).sort().map((k) => `${enc(k)}="${enc(params[k])}"`).join(', ')}`;
}

export function xPoster({ apiKey, apiSecret, accessToken, accessTokenSecret, fetchImpl = fetch }) {
  return {
    name: 'X',
    async post(text) {
      const authorization = oauth1Header({ method: 'POST', url: TWEETS_URL, consumerKey: apiKey, consumerSecret: apiSecret, token: accessToken, tokenSecret: accessTokenSecret });
      const res = await request(fetchImpl, TWEETS_URL, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const { data } = await res.json();
      return { url: `https://x.com/i/web/status/${data.id}` };
    },
  };
}
