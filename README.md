# Jared''s Ideas

A one-page Vercel app where visitors submit business ideas and get rated as Dumb, Meh, Kinda Good, or Really Good.

## Tech
- Static frontend: `index.html`, `styles.css`, `script.js`
- Vercel serverless API: `api/ideas.js`
- Database: Neon Postgres via `@neondatabase/serverless`
- AI rating: DeepSeek Chat Completions API

## Environment Variables
Create `DATABASE_URL` in Vercel Project Settings -> Environment Variables.

Use your Neon Postgres connection string (not the `apirest` Data API URL).

Create `DEEPSEEK_API_KEY` in Vercel Project Settings -> Environment Variables.

Optional: set `DEEPSEEK_MODEL` (default is `deepseek-chat`).
Optional: set `RERATE_ADMIN_TOKEN` to enable protected rerating of existing rows.

## Local Dev
1. `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `DEEPSEEK_API_KEY`
3. `npm run dev`

## Rerate Existing Ideas
To rerate existing records to the new style in batches:

1. Set `RERATE_ADMIN_TOKEN` in Vercel.
2. Call `POST /api/ideas` with JSON:

```json
{
  "action": "rerate_all",
  "adminToken": "your-token",
  "limit": 20
}
```

Run it multiple times until older ideas are rerated. `limit` max is 50 per request.

## Deploy on Vercel
1. Import this repo in Vercel
2. Framework preset: `Other`
3. Set `DATABASE_URL` and `DEEPSEEK_API_KEY`
4. Deploy
