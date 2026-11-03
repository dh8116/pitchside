// iMessage via a self-hosted BlueBubbles server (https://bluebubbles.app).
// Apple has no public iMessage API; BlueBubbles runs on a Mac signed in to
// iMessage and exposes a REST API + webhooks. In BlueBubbles, add a webhook
// for "New Messages" pointing at {PUBLIC_URL}/webhooks/imessage?secret=…
import { randomUUID } from 'node:crypto';
import { bubbleToText } from '../format.js';
import { ok, deny, request, safeEqual, sendInOrder } from './util.js';

export function imessageChannel({ serverUrl, password, webhookSecret, fetchImpl = fetch, gapMs }) {
  return {
    name: 'imessage',

    webhook({ method, url, rawBody }) {
      if (method !== 'POST') return deny(405);
      if (!webhookSecret || !safeEqual(url.searchParams.get('secret'), webhookSecret)) return deny(401);
      const { type, data } = JSON.parse(rawBody.toString('utf8') || '{}');
      if (type !== 'new-message' || !data || data.isFromMe) return ok();
      const handle = data.handle?.address;
      const chatGuid = data.chats?.[0]?.guid;
      if (!handle || !chatGuid || chatGuid.includes(';+;')) return ok(); // skip group chats
      return {
        ...ok(),
        messages: [{ key: `imessage:${handle}`, channel: 'imessage', address: chatGuid, messageId: data.guid, text: data.text }],
      };
    },

    async send(user, bubbles) {
      const url = `${serverUrl.replace(/\/$/, '')}/api/v1/message/text?password=${encodeURIComponent(password)}`;
      await sendInOrder(bubbles, (b) => request(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatGuid: user.address, message: bubbleToText(b), tempGuid: randomUUID(), method: 'apple-script' }),
      }), gapMs);
    },
  };
}
