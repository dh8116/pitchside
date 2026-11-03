// WhatsApp via Meta's WhatsApp Cloud API.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
import { createHmac } from 'node:crypto';
import { bubbleToText } from '../format.js';
import { ok, deny, request, safeEqual, sendInOrder } from './util.js';

export function whatsappChannel({ token, phoneNumberId, verifyToken, appSecret, graphVersion = 'v21.0', fetchImpl = fetch, gapMs }) {
  return {
    name: 'whatsapp',

    webhook({ method, url, headers, rawBody }) {
      if (method === 'GET') {
        // One-time subscription handshake from Meta.
        const p = url.searchParams;
        if (p.get('hub.mode') === 'subscribe' && verifyToken && safeEqual(p.get('hub.verify_token'), verifyToken)) {
          return ok(p.get('hub.challenge') ?? '');
        }
        return deny();
      }
      if (appSecret) {
        const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
        if (!safeEqual(headers['x-hub-signature-256'], expected)) return deny(401);
      }
      const payload = JSON.parse(rawBody.toString('utf8') || '{}');
      const messages = [];
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const m of change.value?.messages ?? []) {
            const text = m.type === 'text' ? m.text?.body
              : m.type === 'button' ? m.button?.text
              : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title)
              : '(sent something I can only read as text. Type it out?)';
            messages.push({ key: `whatsapp:+${m.from}`, channel: 'whatsapp', address: m.from, messageId: m.id, text });
          }
        }
      }
      return { ...ok(), messages };
    },

    async send(user, bubbles) {
      const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
      await sendInOrder(bubbles, (b) => request(fetchImpl, url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: user.address, type: 'text', text: { body: bubbleToText(b), preview_url: true } }),
      }), gapMs);
    },
  };
}
