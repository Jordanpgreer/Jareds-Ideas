const { neon } = require("@neondatabase/serverless");

const MAX_IDEA_LENGTH = 180;
const RATINGS = ["Dumb", "Meh", "Kinda Good", "Really Good"];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
let tableReady = false;

function pickRating(ideaText) {
  const normalized = ideaText.trim().toLowerCase();
  const seed = [...normalized].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const weightedPool = [0, 1, 1, 2, 2, 3];
  return RATINGS[weightedPool[seed % weightedPool.length]];
}

function normalizeIdea(value) {
  if (typeof value !== "string") {
    return "";
  }

  // Collapse whitespace to keep stored text clean and predictable.
  return value.replace(/\s+/g, " ").trim();
}

async function ensureTable(sql) {
  if (tableReady) {
    return;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS ideas (
      id BIGSERIAL PRIMARY KEY,
      idea_text VARCHAR(${MAX_IDEA_LENGTH}) NOT NULL,
      rating VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS ideas_created_at_idx
    ON ideas (created_at DESC);
  `;

  tableReady = true;
}

function parseJsonBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!ALLOWED_METHODS.includes(req.method)) {
    res.setHeader("Allow", ALLOWED_METHODS.join(", "));
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;

  if (!databaseUrl) {
    return res.status(500).json({ error: "Missing DATABASE_URL environment variable." });
  }

  const sql = neon(databaseUrl);

  try {
    await ensureTable(sql);

    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, idea_text, rating, created_at
        FROM ideas
        ORDER BY created_at DESC
        LIMIT 100;
      `;

      return res.status(200).json({ ideas: rows });
    }

    const body = parseJsonBody(req);
    const idea = normalizeIdea(body.idea);

    if (!idea) {
      return res.status(400).json({ error: "Idea is required." });
    }

    if (idea.length > MAX_IDEA_LENGTH) {
      return res.status(400).json({ error: `Idea must be ${MAX_IDEA_LENGTH} characters or less.` });
    }

    const rating = pickRating(idea);
    const [created] = await sql`
      INSERT INTO ideas (idea_text, rating)
      VALUES (${idea}, ${rating})
      RETURNING id, idea_text, rating, created_at;
    `;

    return res.status(201).json({ idea: created });
  } catch (error) {
    console.error("ideas API error", error);
    return res.status(500).json({ error: "Failed to process request." });
  }
};