# Atlas Telegram Bot

Minimal Telegraf service for Atlas Oracle interactions over Telegram.

## Commands

- `/start` — introduces The Oracle and prompts the user to link Atlas
- `/link <handle>` — binds the current Telegram chat to an Atlas user handle

## Setup

1. Install dependencies from the repo root, or run `npm install` inside `services/telegram-bot`.
2. Provide environment variables for the bot process:
   - `BOT_TOKEN` — Telegram bot token
   - `DATABASE_URL` — PostgreSQL connection string for Prisma
3. Start the bot with long polling:
   - `npm run dev`
   - or `npm run build && npm run start`

## Notes

- This service uses long polling only. Webhook deployment is intentionally separate.
- `/link` is a simple handle-based scaffold. It does not yet verify account ownership with a signed Atlas token.
- Shared Oracle voice comes from `services/api/src/lib/oracle-prompt.ts`.
- Shared Prisma client comes from `prisma/index.ts`.
