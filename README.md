# Persistent Color Bingo — Telegram Mini App

This starter adds PostgreSQL persistence to a live-multiplayer Bingo demo. **All real-money functionality is disabled and absent.** The demo's 100-point shared pool is fictional and has no cash value.

## Requirements
- Node.js 20+
- PostgreSQL 14+
- Telegram bot token from @BotFather
- Public HTTPS deployment for Telegram Mini Apps

## Local setup
1. Install PostgreSQL and create a database/user, for example:
   ```sql
   CREATE USER bingo_user WITH PASSWORD 'replace-this-password';
   CREATE DATABASE bingo OWNER bingo_user;
   ```
2. Copy `.env.example` to `.env`; set `DATABASE_URL`, `BOT_TOKEN`, and `MINI_APP_URL`.
3. Install packages:
   ```bash
   npm install
   ```
4. Initialize the schema:
   ```bash
   npm run db:init
   ```
5. Start the server:
   ```bash
   npm start
   ```
6. Visit `/health` on your server. It should return `ok: true`.
7. In Telegram, send `/start` to your bot and tap Play Bingo.

For local browser testing only, `ALLOW_DEV_AUTH=true` enables a demo identity. **Set `ALLOW_DEV_AUTH=false` in production**. Use a publicly accessible HTTPS URL for Telegram.

## Persistent behavior
- Users, rooms, rounds, cards, number calls, claims, winners and audit events are stored in PostgreSQL.
- A player who reconnects can rejoin a waiting room and receive the same saved card.
- Number draws use Node's cryptographic random functions.
- Valid Bingo claims are recorded server-side. The round remains open for multiple winners until someone presses Finish demo round.
- The demo simulates 100 fictional points split equally among winners; it is not a balance or payout.

## Important production work still required
This is a starter, not a fully hardened production service:
- Persist a round's full shuffled draw sequence before play, or use a documented verifiable RNG protocol; current draws are individually random and persisted as called.
- Add an authorized moderator/scheduler to finish rounds; the demo currently allows a participant to request finishing after a winner exists.
- Add rate limiting, reconnection/duplicate-session policy, abuse controls, structured logging, backups, migrations, monitoring, and automated concurrency tests.
- Review Socket.IO scaling and shared timer coordination before running multiple app instances.
- Use TLS, private database networking, strong credentials, managed secrets, and tested restore procedures.
- Do not enable real-money entry, deposits, withdrawals, or cash prizes until qualified Ethiopian counsel and the relevant authorities have confirmed the game may operate and the payment provider has explicitly approved it.
- Never treat the fictional demo points as cash, redeemable value, or a promise of future payout.

## Core tables
`app_users`, `rooms`, `rounds`, `round_players`, `called_numbers`, `bingo_claims`, `round_winners`, and `game_audit_events`. See `schema.sql`.
