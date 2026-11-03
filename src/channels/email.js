// Email via Postmark (inbound webhook + outbound API). People email or CC
// your Pitchside address; replies come back in the same thread.
// Inbound webhook URL: {PUBLIC_URL}/webhooks/email?secret=…
import { bubblesToEmail } from '../format.js';
import { ok, deny, request, safeEqual } from './util.js';

const header = (headers, name) => headers?.find((h) => h.Name?.toLowerCase() === name.toLowerCase())?.Value;

export function emailChannel({ serverToken, from, webhookSecret, fetchImpl = fetch }) {
  const ownAddress = from.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? from.toLowerCase();

  return {
    name: 'email',

    webhook({ method, url, rawBody }) {
      if (method !== 'POST') return deny(405);
      if (!webhookSecret || !safeEqual(url.searchParams.get('secret'), webhookSecret)) return deny(401);
      const mail = JSON.parse(rawBody.toString('utf8') || '{}');
      const sender = mail.FromFull?.Email?.toLowerCase();
      const auto = header(mail.Headers, 'Auto-Submitted');
      if (!sender || sender === ownAddress || (auto && auto !== 'no')) return ok(); // ignore loops & auto-replies

      const text = (mail.StrippedTextReply || mail.TextBody || '').trim();
      const messageId = header(mail.Headers, 'Message-ID') ?? mail.MessageID;
      const references = [header(mail.Headers, 'References'), messageId].filter(Boolean).join(' ');
      return {
        ...ok(),
        messages: [{
          key: `email:${sender}`,
          channel: 'email',
          address: sender,
          messageId,
          text: mail.Subject && !/^re:/i.test(mail.Subject) ? `Subject: ${mail.Subject}\n\n${text}` : text,
          meta: { emailSubject: mail.Subject || 'Pitchside', emailInReplyTo: messageId, emailReferences: references },
        }],
      };
    },

    async send(user, bubbles) {
      const subject = user.meta?.emailSubject ?? 'Pitchside';
      const headers = user.meta?.emailInReplyTo
        ? [{ Name: 'In-Reply-To', Value: user.meta.emailInReplyTo }, { Name: 'References', Value: user.meta.emailReferences }]
        : [];
      await request(fetchImpl, 'https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'x-postmark-server-token': serverToken, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          From: from,
          To: user.address,
          Subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
          TextBody: bubblesToEmail(bubbles),
          Headers: headers,
          MessageStream: 'outbound',
        }),
      });
    },
  };
}
