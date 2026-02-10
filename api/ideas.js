const { neon } = require("@neondatabase/serverless");

const MAX_IDEA_LENGTH = 180;
const RATINGS = ["Dumb", "Meh", "Kinda Good", "Really Good"];
const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];
const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const AI_TIMEOUT_MS = 12000;
const DEFAULT_NOTES_BY_RATING = {
  Dumb: "dumb - bad idea",
  Meh: "meh - no profit",
  "Kinda Good": "kinda good - needs a clearer money path",
  "Really Good": "really good - realistic and profitable"
};
const OLD_DEFAULT_NOTES = new Set([
  "Just a plain dumb idea.",
  "Very kind, but not profitable.",
  "Some potential, but it needs a clearer path to real profit.",
  "Strong, realistic, and clearly profit-oriented.",
  "Bold, chaotic, and financially allergic.",
  "Cute concept, but the profit math is missing."
]);
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

function normalizeNote(value, rating) {
  const fallback = DEFAULT_NOTES_BY_RATING[rating] || "";

  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.replace(/\s+/g, " ").trim().replace(/[.]+$/g, "");
  if (!cleaned) {
    return fallback;
  }

  const limited = cleaned.slice(0, 90);

  if (rating === "Dumb") {
    return /^dumb\s*-/i.test(limited) ? limited : `dumb - ${limited.toLowerCase()}`;
  }

  if (rating === "Meh") {
    return /^meh\s*-/i.test(limited) ? limited : `meh - ${limited.toLowerCase()}`;
  }

  return limited;
}

function applyProfitabilityGuardrail(ideaText, aiResult) {
  const text = ideaText.toLowerCase();
  const lacksClearRevenue =
    !/(subscription|fee|membership|ads|advertis|sponsor|commission|marketplace|sell|sales|price|paid|paying|b2b|enterprise|saas|licens)/i.test(
      text
    );
  const charityLike = /(charity|donat|free food|feed (the )?homeless|nonprofit|without food|give away)/i.test(text);

  if (charityLike && lacksClearRevenue) {
    return {
      rating: "Meh",
      note: "meh - heart is good, business model is missing"
    };
  }

  if (aiResult.rating === "Really Good" && lacksClearRevenue) {
    return {
      rating: "Kinda Good",
      note: "kinda good - idea is decent, but revenue path is unclear"
    };
  }

  return aiResult;
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
              "For Dumb and Meh ratings, use a short edgy witty style (2-6 words), with format like " +
              '"dumb - <tag>" or "meh - <tag>". If idea is discriminatory, call it out directly (example: "dumb - racist").'
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
    const finalNote = normalizeNote(parsedNote && parsedNote.length <= 140 ? parsedNote : fallbackNote, parsedRating);
    return { rating: parsedRating, note: finalNote };
  } finally {
    clearTimeout(timeout);
  }
}

async function rerateIdeas(sql, apiKey, model, limit = 20) {
  const rows = await sql`
    SELECT id, idea_text
    FROM ideas
    ORDER BY created_at DESC
    LIMIT ${limit};
  `;

  let updated = 0;
  for (const row of rows) {
    const aiResult = await getAiRating(row.idea_text, apiKey, model);
    await sql`
      UPDATE ideas
      SET rating = ${aiResult.rating}, rating_note = ${aiResult.note}
      WHERE id = ${row.id};
    `;
    updated += 1;
  }

  return { selected: rows.length, updated };
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
        rating_note:
          row.rating_note && row.rating_note.trim() && !OLD_DEFAULT_NOTES.has(row.rating_note.trim())
            ? normalizeNote(row.rating_note, row.rating)
            : DEFAULT_NOTES_BY_RATING[row.rating] || ""
      }));

      return res.status(200).json({ ideas: normalizedRows });
    }

    const body = parseJsonBody(req);

    if (body.action === "rerate_all") {
      const adminToken = process.env.RERATE_ADMIN_TOKEN;
      const providedToken = typeof body.adminToken === "string" ? body.adminToken : "";
      const limitRaw = Number(body.limit);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20;

      if (!adminToken) {
        return res.status(500).json({ error: "Missing RERATE_ADMIN_TOKEN environment variable." });
      }

      if (!providedToken || providedToken !== adminToken) {
        return res.status(401).json({ error: "Unauthorized rerate request." });
      }

      const result = await rerateIdeas(sql, deepseekApiKey, deepseekModel, limit);
      return res.status(200).json({ message: "Ideas rerated.", ...result });
    }

    const idea = normalizeIdea(body.idea);

    if (!idea) {
      return res.status(400).json({ error: "Idea is required." });
    }

    if (idea.length > MAX_IDEA_LENGTH) {
      return res.status(400).json({ error: `Idea must be ${MAX_IDEA_LENGTH} characters or less.` });
    }

    const aiResult = await getAiRating(idea, deepseekApiKey, deepseekModel);
    const finalResult = applyProfitabilityGuardrail(idea, aiResult);
    const [created] = await sql`
      INSERT INTO ideas (idea_text, rating, rating_note)
      VALUES (${idea}, ${finalResult.rating}, ${finalResult.note})
      RETURNING id, idea_text, rating, rating_note, created_at;
    `;

    return res.status(201).json({ idea: created });
  } catch (error) {
    console.error("ideas API error", error);
    return res.status(500).json({ error: "Failed to process request." });
  }
};
