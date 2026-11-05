# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the **Security** tab of this repo and choose **Report a vulnerability**. Don't open a public issue for them.

Include what you found, how to reproduce it, and what it affects (a channel webhook, the browser chat, the .env builder, stored memory). You'll get a reply within 7 days, and a fix or a plan within 30.

## Supported versions

Only the latest commit on `main` is supported. Pitchside is self-hosted, so pull the latest `main` to get fixes.

## Running it safely

- Keep `.env` out of git (it's in `.gitignore`). Never paste API keys into issues or chats.
- On a public server, set `WEB_CHAT_PASSWORD` and a long random `WEBHOOK_SECRET`.
- The [.env builder](https://dh8116.github.io/pitchside/setup/) runs entirely in your browser and only fetches the public `.env.example`; your keys never leave the page.
