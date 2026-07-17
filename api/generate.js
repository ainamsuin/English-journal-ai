// Vercel Serverless Function
// This runs on the server, never in the user's browser.
// The Gemini API key lives only in the GEMINI_API_KEY environment variable
// (set it in your Vercel project's Settings → Environment Variables — never
// commit it to a file or to git).

const PROMPT_TEXT = [
  'You are the engine behind "English Journal AI", a service that turns a Korean diary entry (and optional photos) into English study material for a Korean learner.',
  "",
  "Respond with ONLY a raw JSON object — no markdown code fences, no preamble, no explanation. The JSON must have exactly this shape:",
  "",
  "{",
  '  "easyEnglish": "a short, simple retelling in easy English (roughly A2 level, short plain sentences)",',
  '  "naturalEnglish": "a natural, fluent native-speaker-style retelling of the same entry, more sophisticated than easyEnglish",',
  '  "expressions": ["3 to 5 short useful English expressions or phrases drawn from or relevant to the entry"],',
  '  "vocabulary": [{"word": "english word", "meaning": "short Korean definition"}],',
  '  "speakScript": "a 30-60 second first-person spoken script in English, suitable for reading aloud on camera, starting with a casual greeting like \'Hi everyone.\'",',
  '  "youtubeTitle": "a short catchy title for a vlog/short based on this entry",',
  '  "hashtags": ["5 short hashtag strings without the # symbol"]',
  "}",
  "",
  "Keep vocabulary to 5-8 entries. Base everything on the specific content of the diary (and photos if provided) — be concrete, not generic.",
].join("\n");

// --- very small in-memory rate limiter -------------------------------------------------
// Note: serverless instances are ephemeral and can scale to multiple copies, so this is a
// best-effort speed bump, not a hard guarantee. It stops a single runaway client/script
// from burning through your Gemini quota in a tight loop.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12;
const hits = new Map(); // key -> [timestamps]

function isRateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > RATE_LIMIT_MAX;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Optional shared app password. Set APP_SECRET in your environment variables to require it.
  // The client sends whatever the user typed in the app's settings screen as x-app-secret.
  const appSecret = process.env.APP_SECRET;
  if (appSecret) {
    const provided = req.headers["x-app-secret"];
    if (provided !== appSecret) {
      res.status(401).json({ error: "Unauthorized: 앱 비밀번호가 올바르지 않습니다." });
      return;
    }
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").toString().split(",")[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: "요청이 너무 많아요. 잠시 후 다시 시도해주세요." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "서버에 GEMINI_API_KEY가 설정되어 있지 않습니다." });
    return;
  }

  try {
    const { korean, photos, model } = req.body || {};

    if (!korean || typeof korean !== "string" || !korean.trim()) {
      res.status(400).json({ error: "korean text is required" });
      return;
    }
    if (korean.length > 8000) {
      res.status(400).json({ error: "일기 내용이 너무 깁니다." });
      return;
    }

    const safePhotos = Array.isArray(photos) ? photos : [];
    const parts = [{ text: PROMPT_TEXT + "\n\n한국어 일기:\n" + korean }];

    const TOTAL_PHOTO_BYTES_LIMIT = 4 * 1024 * 1024; // keep in sync with the client's TOTAL_PHOTO_BYTES_LIMIT — max achievable under Vercel's fixed 4.5MB request body cap
    let usedBytes = 0;

    for (const p of safePhotos) {
      if (typeof p !== "string" || !p.startsWith("data:image/")) continue;
      const commaIdx = p.indexOf(",");
      if (commaIdx === -1) continue;
      const meta = p.slice(0, commaIdx);
      const data = p.slice(commaIdx + 1);
      // Skip any single image over ~2.8MB base64, and stop once the running total would
      // exceed the shared budget — this is a server-side backstop even though the client
      // already enforces the same limit before sending.
      if (data.length > 2_800_000) continue;
      if (usedBytes + data.length > TOTAL_PHOTO_BYTES_LIMIT) break;
      usedBytes += data.length;
      const mimeMatch = meta.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
      parts.push({ inline_data: { mime_type: mimeMatch ? mimeMatch[1] : "image/jpeg", data } });
    }

    // Only allow a conservative model-name character set — this value is interpolated into a URL.
    const modelName = typeof model === "string" && /^[a-zA-Z0-9._-]{1,60}$/.test(model) ? model : "gemini-flash-latest";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      res.status(geminiRes.status).json({ error: `Gemini error: ${errText.slice(0, 400)}` });
      return;
    }

    const data = await geminiRes.json();
    const cand = data.candidates && data.candidates[0];
    const text =
      cand && cand.content && cand.content.parts
        ? cand.content.parts.map((p) => p.text || "").join("\n")
        : "";

    if (!text) {
      res.status(502).json({ error: "AI 응답이 비어있습니다." });
      return;
    }

    // We only forward the raw text back to the client; the client parses it as JSON.
    // The Gemini API key itself never leaves this server.
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Unknown server error" });
  }
}
