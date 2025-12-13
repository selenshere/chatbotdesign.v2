import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Image intent detection + prompt builder (kept separate from Taylor system prompt) ----
const INTENT_SYSTEM_PROMPT = `
You are an intent detector. Output ONLY valid JSON.

Decide whether the user explicitly requests a visual or diagram of a fraction.
This includes requests like drawing, showing, visualizing, number line, area model,
or equivalent expressions in ANY language.

If the user does NOT explicitly request a visual, return:
{"generate_image": false}

If the user DOES explicitly request a visual, return:
{
  "generate_image": true,
  "image_type": "numberline" or "areamodel",
  "numerator": integer or null,
  "denominator": integer or null
}

Do not explain anything. Do not suggest visuals.
`.trim();

function buildImagePrompt(type, n, d) {
  if (type === "areamodel") {
    return `Clean educational diagram, white background. A rectangle representing 1 whole divided into ${d} equal parts. Shade ${n} parts to represent ${n}/${d}. Label "${n}/${d}". Minimal style, high contrast.`;
  }
  return `Clean educational diagram, white background. A number line from 0 to 1 divided into ${d} equal intervals. Highlight ${n}/${d} with a segment from 0 to ${n}/${d} and label "${n}/${d}". Minimal style, high contrast.`;
}

// ---- Middleware ----
app.use(express.json({ limit: "1mb" }));

// ---- Simple in-memory rate limit (per instance) ----
// Env:
//  - RATE_LIMIT_WINDOW_MS (default 600000 = 10 min)
//  - RATE_LIMIT_MAX (default 40)
// Notes: Render free plan may run a single instance. This is best-effort, not a distributed limiter.
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "600000", 10);
const MAX_REQ = parseInt(process.env.RATE_LIMIT_MAX || "40", 10);
const hits = new Map(); // ip -> {count, resetAt}

function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim() || "unknown";
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  rec.count += 1;
  if (rec.count > MAX_REQ) {
    const retryAfterSec = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    res.setHeader("Retry-After", retryAfterSec.toString());
    return res.status(429).send("Too many requests. Please wait and try again.");
  }
  return next();
}

// ---- Static frontend ----
app.use(express.static("public"));

// ---- Health ----
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---- OpenAI proxy endpoint ----
// IMPORTANT: Keep OPENAI_API_KEY only on server (Render env var).
// Optional access code:
//  - STUDY_CODE (if set, require header 'x-study-code' or body.studyCode to match)
app.post("/api/chat", rateLimit, async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).send("Missing OPENAI_API_KEY env var on server.");

    const requiredCode = process.env.STUDY_CODE;
    if (requiredCode) {
      const got = (req.headers["x-study-code"] || req.body?.studyCode || "").toString().trim();
      if (got !== requiredCode) return res.status(401).send("Unauthorized (missing/invalid study code).");
    }

    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).send("Missing messages array.");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // ---- Intent check (language-agnostic). Only used to decide whether to generate an image. ----
    let intent = { generate_image: false };
    try {
      const lastUser = [...messages].reverse().find(m => m?.role === "user")?.content || "";
      const intentUpstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: INTENT_SYSTEM_PROMPT },
            { role: "user", content: lastUser }
          ],
          temperature: 0,
          max_tokens: 80
        })
      });
      if (intentUpstream.ok) {
        const intentData = await intentUpstream.json();
        const raw = intentData?.choices?.[0]?.message?.content ?? "";
        intent = JSON.parse(raw);
      }
    } catch {
      intent = { generate_image: false };
    }

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 120
      })
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      return res.status(upstream.status).send(txt || "Upstream error");
    }

    const data = await upstream.json();
    const reply = data?.choices?.[0]?.message?.content ?? "";

    // ---- Optional image generation (ONLY when the user explicitly asked) ----
    let image = null;
    if (
      intent?.generate_image === true &&
      Number.isInteger(intent?.numerator) &&
      Number.isInteger(intent?.denominator) &&
      intent.denominator > 0 &&
      intent.numerator >= 0
    ) {
      try {
        const imgUpstream = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: "gpt-image-1",
            prompt: buildImagePrompt(intent.image_type, intent.numerator, intent.denominator),
            size: "1024x1024",
            response_format: "url"
          })
        });
        if (imgUpstream.ok) {
          const imgData = await imgUpstream.json();
          image = imgData?.data?.[0]?.url || null;
          // Fallback if upstream returns base64 instead of url
          if (!image && imgData?.data?.[0]?.b64_json) {
            image = `data:image/png;base64,${imgData.data[0].b64_json}`;
          }
        }
      } catch {
        image = null;
      }
    }

    return res.json({ reply, image });
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
});

// SPA fallback (optional): always serve index.html for unknown routes
app.get("*", (_req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
