// SMS and WhatsApp via Twilio Programmable Messaging.
// Point a Twilio number's (or WhatsApp sender's) "A message comes in" webhook
// at  {PUBLIC_URL}/webhooks/twilio
import { createHmac } from 'node:crypto';
import { bubbleToText } from '../format.js';
import { ok, deny, request, safeEqual, sendInOrder } from './util.js';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the full URL + sorted POST params. */
export function twilioSignature(authToken, fullUrl, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], fullUrl);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function twilioChannel({ accountSid, authToken, smsFrom, whatsappFrom, publicUrl, fetchImpl = fetch, gapMs }) {
  return {
    name: 'twilio',

    webhook({ method, url, headers, rawBody }) {
      if (method !== 'POST') return deny(405);
      const params = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
      const fullUrl = `${publicUrl.replace(/\/$/, '')}${url.pathname}${url.search}`;
      if (!safeEqual(headers['x-twilio-signature'], twilioSignature(authToken, fullUrl, params))) return deny(401);

      const reply = { ...ok(EMPTY_TWIML, { 'content-type': 'text/xml' }) };
      if (!params.From || params.Body === undefined) return reply;
      const isWhatsapp = params.From.startsWith('whatsapp:');
      const number = params.From.replace(/^whatsapp:/, '');
      reply.messages = [{
        key: isWhatsapp ? `whatsapp:${number}` : `sms:${number}`,
        channel: 'twilio',
        address: params.From, // keeps the whatsapp: prefix so replies go back the same way
        messageId: params.MessageSid,
        text: params.Body,
      }];
      return reply;
    },

    async send(user, bubbles) {
      const from = user.address.startsWith('whatsapp:') ? whatsappFrom : smsFrom;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      await sendInOrder(bubbles, (b) => request(fetchImpl, url, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: user.address, Body: bubbleToText(b) }),
      }), gapMs);
    },
  };
}
