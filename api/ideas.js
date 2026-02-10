const { neon } = require("@neondatabase/serverless");

const MAX_IDEA_LENGTH = 180;
const RATINGS = ["Dumb", "Meh", "Kinda Good", "Really Good"];
let tableReady = false;

function pickRating(ideaText) {
  const normalized = ideaText.trim().toLowerCase();
  const seed = [...normalized].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const weightedPool = [0, 1, 1, 2, 2, 3];
  return RATINGS[weightedPool[seed % weightedPool.length]];
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

    if (req.method === "POST") {
      const body = parseJsonBody(req);
      const idea = typeof body.idea === "string" ? body.idea.trim() : "";

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
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("ideas API error", error);
    return res.status(500).json({ error: "Failed to process request." });
  }
};
