# Jared''s Ideas

A one-page Vercel app where visitors submit business ideas and get rated as Dumb, Meh, Kinda Good, or Really Good.

## Tech
- Static frontend: `index.html`, `styles.css`, `script.js`
- Vercel serverless API: `api/ideas.js`
- Database: Neon Postgres via `@neondatabase/serverless`

## Environment Variables
Create `DATABASE_URL` in Vercel Project Settings -> Environment Variables.

Use your Neon Postgres connection string (not the `apirest` Data API URL).

## Local Dev
1. `npm install`
2. Copy `.env.example` to `.env` and set `DATABASE_URL`
3. `npm run dev`

## Deploy on Vercel
1. Import this repo in Vercel
2. Framework preset: `Other`
3. Set `DATABASE_URL`
4. Deploy