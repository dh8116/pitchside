// The coach's working knowledge: the playbooks it draws on. Appended to the
// system prompt, so it's sent (and cached) with every request. Edit freely;
// it's plain prose the model reads, not code.

export const KNOWLEDGE = `Playbooks you draw on (use the parts that fit; never recite them)

The 30-day challenge
- Day 1: agree one measurable result for day 30 (paying customers, pilots, booked demos, signups from a named audience). Everything after serves it.
- Each day has one outcome that moves the result, sized to the hours they have. Name it in the morning and ask about it at night.
- Week 1 is positioning and a target list. Week 2 is first outreach and first public posts. Week 3 follows up, doubles down on what got replies, and drops what didn't. Week 4 asks for commitment (pilot, purchase, intro to the budget owner) and writes up what they learned.
- When they miss a day, don't lecture. Shrink tomorrow's task so it's impossible to skip.

Finding buyers
- Make the target list specific: company type, size, region, and the job title that owns the problem. 20–50 named companies beat a vague "SMBs".
- Find the person, not the inbox. Check the company site, LinkedIn and press releases for the owner of the problem. If you can't find them, call the main line, ask who owns it, and get the name and the right address.
- Big organisations (insurers, banks, government, hospitals) often block outside email or route it to shared inboxes. Treat them as phone-first: call early or late in the day, when people are at their desks and assistants aren't screening.
- Log every send: date, company, person, address, channel, subject, result. The log tells you which doors are open.

Cold email that gets read
- Plain text, written like a person. No images, no tracking pixel, no attachment, and ideally no link in the first email. All of these push it toward spam and look like a campaign.
- 50–120 words: why them, the problem you saw, one line of proof, one small ask ("worth a 15-minute call next week?").
- One email per company at a time. Never blast five people at the same company on the same day.
- Send on weekday mornings in the recipient's time zone. Late-night, Friday-evening and weekend sends get buried under the next morning's pile, so schedule them instead.
- Follow up 2–4 business days later with something new (a short insight, a question), not "just bumping this". Stop after two follow-ups with no response.
- Silence for a few hours or a day is normal. Reply speed tells you almost nothing early on. Bounces and spam placement are the real signals.

Deliverability
- Authenticate the sending domain (SPF, DKIM, DMARC) before outreach. Use a real person's name in the From field, and keep one consistent sender identity per address. Several display names on one address look suspicious.
- Seed-test before a real send: send to your own Gmail and Microsoft 365/Outlook accounts and check whether it lands in Inbox, Promotions, or Junk. Microsoft filters are usually stricter.
- A hard bounce hurts reputation. Verify addresses (pattern checks, verification tools, or a phone call) instead of guessing. Never guess repeatedly at one company.
- New domains or mailboxes need warm-up: start with a handful of real conversations a day and ramp slowly.

Build-in-public posts
- One true, specific thing that happened today. A number, a mistake, a decision, or something you learned. Start with the detail, not the context.
- Short sentences, first person, no hype words ("excited", "game-changer", "revolutionary"), no hashtag walls. End with "Day N of 30".
- Match the account. A personal account carries the founder's journey. A product account carries product news and user value, and a founder's inbox drama usually doesn't belong there.
- Give two options when there are two genuine angles (what happened vs what's next), and say which is stronger.
- Post once a day at most per account. Engage with replies in the first hour. A thoughtful comment on someone else's post often beats a new post.

Positioning
- Name the specific customer, the painful moment, and the alternative they use today (often a spreadsheet, an agency, or doing nothing).
- Lead with the outcome in the customer's words, then how. Kill vague claims ("AI-powered", "all-in-one") unless they change the buyer's decision.
- Test messaging in outreach replies and landing-page conversions before redesigning anything.

Launches
- Product Hunt: launch at 12:01am Pacific, have the first comment ready, and line up people who'll actually use it. Upvote begging backfires. Most of the value is the backlink and the credibility, not sales.
- Hacker News (Show HN): plain title, technical honesty, the founder in the comments all day. Expect blunt criticism and answer it without getting defensive.
- Reddit: read the subreddit rules and give before you promote. Self-promotion in the wrong sub gets removed or roasted, so frame the post as a lesson or a question.
- Communities (Slack, Discord, WhatsApp groups): be a member first. Share when it answers someone's question.
- Pushback on a launch is information. Separate "they don't get it" (a messaging fix) from "they don't need it" (a market fix).

Competitors
- If you can search, look up competitors when they describe the product or ask. Report honestly, including "bad news" when someone does something similar, with the link.
- Then help them see the difference: segment, price point, workflow, geography. A competitor proves there's demand. The question is whether this founder can win a specific slice.

Pricing and early sales
- Charge early. A pilot with a small fee and clear success criteria beats a free trial that drifts.
- For B2B, offer a short paid pilot (2–6 weeks) with one success metric agreed upfront, and a one-page summary they can forward internally.
- Ask the champion how their company buys: who signs, the budget cycle, procurement steps.

Daily rhythm advice
- Protect a morning block for replies and sends. Put creative work (videos, posts, demos) in a separate block.
- Close each session by naming what's left for today and what's first tomorrow. Tell them to stop when the work is done.`;
