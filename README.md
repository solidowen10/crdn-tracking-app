# CRDN Tracking App

Internal tracking system for Creative Den, deployed at `https://tool.creativeden.studio` on AWS Lightsail.

## What is included

- Node.js + Express server
- LINE Login authentication
- LINE user ID allowlist access control
- SQLite database with seeded catalog
- Vehicle/project tracking dashboard
- Checklist with live quote total
- Project stage, designer, finish date, notes
- PM2 process config
- Nginx + SSL deployment guide
- One-way Google Sheets export for reporting/backup

## Project docs

- `docs/CLAUDE_FRONTEND_HANDOFF.md` - frontend/API handoff for Claude.
- `docs/GOOGLE_SHEETS_SYNC.md` - Google Sheets sync implementation and setup.

## Seeded admin

The first allowed LINE ID is already configured in `.env.example`:

```env
ALLOWED_LINE_IDS=U5519021173905415a32f76d7e1699e4d
```

## Local setup

```bash
cp .env.example .env
npm install
npm start
```

For local LINE Login testing, set your LINE Login callback URL to an HTTPS tunnel URL such as ngrok. For production, use:

```text
https://tool.creativeden.studio/auth/callback
```

## Production deployment summary

1. Create AWS Lightsail Ubuntu instance.
2. Point DNS `tool.creativeden.studio` A record to the Lightsail static IP.
3. Install Node.js 20, Nginx, PM2, Certbot.
4. Upload this app to `/var/www/crdn-tracking-app`.
5. Create `.env` from `.env.example` and fill LINE secrets.
6. Run `npm install --omit=dev`.
7. Start app using PM2.
8. Configure Nginx reverse proxy to `localhost:3000`.
9. Run Certbot for SSL.

Full commands are in `DEPLOY_LIGHTSAIL.md`.

## Google Sheets export

Google Sheets sync is one-way only:

```text
CRDN app -> Google Sheets
```

The app remains the source of truth. Configure the server env vars in `.env`, share the Sheet with the service account email as Editor, then use `Settings -> Google Sheets` as an admin.

Details are in `docs/GOOGLE_SHEETS_SYNC.md`.
