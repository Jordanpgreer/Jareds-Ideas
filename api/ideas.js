const { neon } = require("@neondatabase/serverless");

const MAX_IDEA_LENGTH = 180;
const RATINGS = ["Dumb", "Meh", "Kinda Good", "Really Good"];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const AI_TIMEOUT_MS = 12000;
let tableReady = false;

function normalizeRating(value) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim().toLowerCase();

  if (text === "dumb") {
    return "Dumb";
  }

  if (text === "meh") {
    return "Meh";
  }

  if (text === "kinda good" || text === "kinda-good") {
    return "Kinda Good";
  }

  if (text === "really good" || text === "really-good") {
    return "Really Good";
  }

  return null;
}

function extractRatingFromText(text) {
  if (typeof text !== "string") {
    return null;
  }

  const direct = normalizeRating(text);
  if (direct) {
    return direct;
  }

  for (const rating of RATINGS) {
    const regex = new RegExp(`\\b${rating.replace(" ", "\\s+")}\\b`, "i");
    if (regex.test(text)) {
      return rating;
    }
  }

  return null;
}

async function getAiRating(ideaText, apiKey, model) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are rating business ideas. Return only one of these exact labels: Dumb, Meh, Kinda Good, Really Good."
          },
          {
            role: "user",
            content: `Idea: ${ideaText}\n\nRespond with JSON exactly like {"rating":"<one label>"}.`
          }
        ],
        response_format: {
          type: "json_object"
        }
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiMessage =
        data && data.error && typeof data.error.message === "string" ? data.error.message : "DeepSeek request failed.";
      throw new Error(apiMessage);
    }

    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    let parsedRating = null;

    if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(content);
        parsedRating = normalizeRating(parsed && parsed.rating);
      } catch {
        parsedRating = null;
      }
    }

    if (!parsedRating) {
      parsedRating = extractRatingFromText(content);
    }

    if (!parsedRating) {
      throw new Error("DeepSeek returned an invalid rating.");
    }

    return parsedRating;
  } finally {
    clearTimeout(timeout);
  }
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
      idea_text VARCHAR(180) NOT NULL,
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
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  const deepseekModel = process.env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL;

  if (!databaseUrl) {
    return res.status(500).json({ error: "Missing DATABASE_URL environment variable." });
  }

  if (!deepseekApiKey) {
    return res.status(500).json({ error: "Missing DEEPSEEK_API_KEY environment variable." });
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

    const rating = await getAiRating(idea, deepseekApiKey, deepseekModel);
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
