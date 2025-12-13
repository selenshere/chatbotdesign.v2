import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

/**
 * MULTI-LANG trigger: user explicitly asks to show/draw/visualize
 * - TR/EN/DE + common variants + typo "muber line"
 * NOTE: This is intentionally conservative: only explicit requests.
 */
function wantsImage(text = "") {
  const t = (text || "").toLowerCase();

  // Core "explicit" verbs
  const verbTriggers = [
    // EN
    "show", "draw", "visualize", "illustrate", "diagram", "plot",
    // TR
    "göster", "goster", "çiz", "ciz", "çizer misin", "cizer misin",
    "çizim", "cizim", "görselleştir", "gorsellestir",
    // DE
    "zeig", "zeige", "zeigen", "zeichne", "zeichnen", "darstellen", "stell dar", "abbildung"
  ];

  // Model keywords
  const modelTriggers = [
    "number line", "numberline",
    "sayı doğrusu", "sayi dogrusu",
    "area model", "areamodel",
    "alan modeli",
    // typo
    "muber line"
  ];

  const hasVerb = verbTriggers.some(k => t.includes(k));
  const hasModel = modelTriggers.some(k => t.includes(k));

  // Explicit request = (verb) OR (mentions a model explicitly)
  return hasVerb || hasModel;
}

function whichImageType(text = "") {
  const t = (text || "").toLowerCase();
  if (t.includes("area model") || t.includes("areamodel") || t.includes("alan modeli")) return "areamodel";
  if (t.includes("number line") || t.includes("numberline") || t.includes("sayı doğrusu") || t.includes("sayi dogrusu") || t.includes("muber line")) return "numberline";
  // If user just says "show/draw" without specifying, default:
  return "numberline";
}

function extractFractionFromText(text = "") {
  const m = (text || "").match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  const d = Number(m[2]);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return { numerator: n, denominator: d };
}

function extractFractionFromMessages(messages = []) {
  // Prefer last user message; otherwise search backwards.
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    const f = extractFractionFromText(c);
    if (f) return f;
  }
  return null;
}

function buildImagePrompt(type, n, d) {
  if (type === "areamodel") {
    return `Clean educational diagram, white background. A rectangle representing 1 whole divided into ${d} equal parts. Shade ${n} parts to represent ${n}/${d}. Label "${n}/${d}". Minimal style, high contrast.`;
  }
  return `Clean educational diagram, white background. A number line from 0 to 1 divided into ${d} equal intervals. Highlight ${n}/${d} with a segment from 0 to ${n}/${d} and label "${n}/${d}". Minimal style, high contrast.`;
}

// IMPORTANT: keep Taylor prompt EXACTLY as you provided (unchanged).
const TAYLOR_SYSTEM_PROMPT = `
Persona: You are Taylor, an 8–9-year-old student (sixth grade) who participated in a classroom activity about fractions.
Aim: Your goal is to respond to the teacher’s questions so preservice teacher can understand how you think about the addition operation using mathematical symbols and diagrams of fractions.
In the given question, there is a circle diagram divided into 12 equal parts, and you are asked to do the following: Shade the first 1/4 of the circle and then 1/6 of the circle. What fraction of the circle have you shaded in total?
You approached the task of shading 1/4 and 1/6 of a circle by coloring four and six parts of the whole. You then combined the shaded pieces simply by counting them, concluding that 4 + 6 = 10 and interpreting the result as “1/10.”
You also know a rule: 4/12 + 6/12 = 10/12 when denominators are the same, so your symbolic reasoning may conflict with your diagram reasoning.
Recipients: Your audience is a preservice teacher who wants to analyse your reasoning.
Theme: Use simple, child-like language that may sound uncertain or inconsistent. Be uncertain, make mistakes, and explain them simply. Treat unequal parts as valid fractions. Let your diagram reasoning and symbolic reasoning conflict if necessary. Continue naturally from whatever question the teacher asks next. Show what you think makes sense, even if it is mathematically incorrect. Keep your tone natural and informal. Respond in 1–3 short sentences. Do not use long explanations. Stay in character as Taylor at all times.
`.trim();

app.post("/api/chat", async (req, res) => {
  const { apiKey, messages } = req.body || {};

  const effectiveKey =
  (apiKey && typeof apiKey === "string" ? apiKey : process.env.OPENAI_API_KEY);

  if (!effectiveKey) {
    return res.status(400).json({ reply: "Missing API key.", image: null });
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ reply: "Missing messages.", image: null });
  }

  const lastUser = [...messages].reverse().find(m => m?.role === "user")?.content || "";
  const shouldDraw = wantsImage(lastUser);
  const imageType = whichImageType(lastUser);
  const frac = shouldDraw ? extractFractionFromMessages(messages) : null;

  // 1) Taylor text response (gpt-4o-mini)
  let reply = "";
  try {
    const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${effectiveKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: TAYLOR_SYSTEM_PROMPT },
          ...messages
        ],
        temperature: 0.8,
        max_tokens: 120
      })
    });

    const chatData = await chatResp.json();

    if (!chatResp.ok) {
      const errMsg = chatData?.error?.message || "OpenAI error.";
      // Handle rate limit gracefully
      if (chatResp.status === 429) {
        return res.status(200).json({
          reply: "Rate limit reached. Please wait ~20 seconds and try again.",
          image: null
        });
      }
      return res.status(chatResp.status).json({
        reply: `Proxy error ${chatResp.status}: ${errMsg}`,
        image: null
      });
    }

    reply = (chatData?.choices?.[0]?.message?.content || "").toString().trim();
    if (!reply) reply = "…";
  } catch (e) {
    return res.status(200).json({
      reply: "Connection error. Please try again.",
      image: null
    });
  }

  // 2) Optional image generation (gpt-image-1) ONLY if user explicitly asked AND fraction exists
  let image = null;
  if (shouldDraw && frac?.numerator != null && frac?.denominator != null) {
    try {
      const imgResp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${effectiveKey}`
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: buildImagePrompt(imageType, frac.numerator, frac.denominator),
          size: "512x512"
        })
      });

      const imgData = await imgResp.json();

      if (imgResp.ok) {
        image = imgData?.data?.[0]?.url || null;
        // If your account returns base64 instead, you can handle it here later:
        // const b64 = imgData?.data?.[0]?.b64_json;
      } else {
        // If image rate-limited, we still return text reply
        image = null;
      }
    } catch {
      image = null;
    }
  }

  return res.json({ reply, image });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
