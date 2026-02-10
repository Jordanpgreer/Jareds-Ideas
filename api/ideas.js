const { neon } = require("@neondatabase/serverless");

const MAX_IDEA_LENGTH = 180;
const RATINGS = ["Dumb", "Meh", "Kinda Good", "Really Good"];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const AI_TIMEOUT_MS = 12000;
const DEFAULT_NOTES_BY_RATING = {
  Dumb: "Bold, chaotic, and financially allergic.",
  Meh: "Cute concept, but the profit math is missing.",
  "Kinda Good": "Some potential, but it needs a clearer path to real profit.",
  "Really Good": "Strong, realistic, and clearly profit-oriented."
};
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
              "You are a strict startup evaluator. Rate each idea by realistic execution and profitability potential."
          },
          {
            role: "user",
            content:
              `Idea: ${ideaText}\n\n` +
              "Respond with JSON exactly like " +
              '{"rating":"<one label>","note":"<short verdict>"} ' +
              "where rating is exactly one of: Dumb, Meh, Kinda Good, Really Good. " +
              "The note must be short, direct, and explain realism/profitability. " +
              "If rating is Dumb or Meh, make the note witty but not mean, max 12 words."
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

    let parsedNote = null;

    if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(content);
        parsedRating = normalizeRating(parsed && parsed.rating);
        parsedNote = typeof parsed?.note === "string" ? parsed.note.trim() : null;
      } catch {
        parsedRating = null;
        parsedNote = null;
      }
    }

    if (!parsedRating) {
      parsedRating = extractRatingFromText(content);
    }

    if (!parsedRating) {
      throw new Error("DeepSeek returned an invalid rating.");
    }

    const fallbackNote = DEFAULT_NOTES_BY_RATING[parsedRating];
    const finalNote = parsedNote && parsedNote.length <= 140 ? parsedNote : fallbackNote;
    return { rating: parsedRating, note: finalNote };
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
      rating_note VARCHAR(160) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    ALTER TABLE ideas
    ADD COLUMN IF NOT EXISTS rating_note VARCHAR(160) NOT NULL DEFAULT '';
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
        SELECT id, idea_text, rating, rating_note, created_at
        FROM ideas
        ORDER BY created_at DESC
        LIMIT 100;
      `;

      const normalizedRows = rows.map((row) => ({
        ...row,
        rating_note: row.rating_note && row.rating_note.trim() ? row.rating_note : DEFAULT_NOTES_BY_RATING[row.rating] || ""
      }));

      return res.status(200).json({ ideas: normalizedRows });
    }

    const body = parseJsonBody(req);
    const idea = normalizeIdea(body.idea);

    if (!idea) {
      return res.status(400).json({ error: "Idea is required." });
    }

    if (idea.length > MAX_IDEA_LENGTH) {
      return res.status(400).json({ error: `Idea must be ${MAX_IDEA_LENGTH} characters or less.` });
    }

    const aiResult = await getAiRating(idea, deepseekApiKey, deepseekModel);
    const [created] = await sql`
      INSERT INTO ideas (idea_text, rating, rating_note)
      VALUES (${idea}, ${aiResult.rating}, ${aiResult.note})
      RETURNING id, idea_text, rating, rating_note, created_at;
    `;

    return res.status(201).json({ idea: created });
  } catch (error) {
    console.error("ideas API error", error);
    return res.status(500).json({ error: "Failed to process request." });
  }
};
