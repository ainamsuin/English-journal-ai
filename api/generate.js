// Vercel Serverless Function
// This runs on the server, never in the user's browser.
// The Gemini API key lives only in the GEMINI_API_KEY environment variable
// (set it in your Vercel project's Settings → Environment Variables — never
// commit it to a file or to git).

// Allow this function extra time on plans that support it (Hobby caps at 60s
// regardless of this value; Pro/Enterprise can go higher). Image generation
// for several scenes can take a while, so we ask for the max we can get.
export const config = {
  maxDuration: 60,
};

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
  '  "hashtags": ["5 short hashtag strings without the # symbol"],',
  '  "scenes": [{"text": "the exact sentence(s) from the diary this scene covers", "imagePrompt": "a concrete, specific English description of the subject, setting, action and mood of this single scene, written for an image-generation model — describe WHAT is depicted, not an art style"}]',
  "}",
  "",
  "Keep vocabulary to 5-8 entries. Base everything on the specific content of the diary (and photos if provided) — be concrete, not generic.",
  "",
  "For \"scenes\": break the diary into a sequence of situations, in order, covering the whole entry. As a general rule, use one scene per sentence, but when two or more consecutive sentences describe a single continuous situation, merge them into one scene instead of repeating near-duplicate images. Each imagePrompt must describe only the concrete content of that moment (people, objects, setting, action, mood) — do not mention art style, medium, or color palette; that will be applied separately.",
].join("\n");

// A single shared visual style, applied to every generated image so the whole set
// feels like one consistent, original illustration system rather than generic AI art.
// Described only in terms of visual attributes (palette, composition, texture, mood) —
// never by naming another brand, artist, or existing copyrighted work — so the result
// is the user's own style, not an imitation of anyone else's.
const IMAGE_STYLE_SUFFIX = [
  "Visual style: a minimalist flat illustration with a calm, quiet, documentary mood.",
  "Color palette limited strictly to muted, slightly faded tones — warm beige, ivory, charcoal, olive green, mustard yellow, and concrete gray. No bright, saturated, or neon colors.",
  "Composition: generous negative space, simple geometric shapes, restrained brutalist-leaning structure softened by wabi-sabi imperfection (subtle grain, uneven edges, gentle asymmetry).",
  "Feel: editorial magazine plate meets museum exhibition graphic — orderly, understated, a little poetic.",
  "Flat vector-like shading only, no photorealism, no 3D render look, no gradients that mimic photography.",
  "No text, no letters, no logos, no watermarks, no signature anywhere in the image.",
  "This must be an entirely original composition, not a copy or close imitation of any existing artwork, character, brand, or artist's style.",
].join(" ");

const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const IMAGE_CONCURRENCY = 3;
const IMAGE_TIMEOUT_MS = 45_000;

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

function safeModelName(name, fallback) {
  return typeof name === "string" && /^[a-zA-Z0-9._-]{1,60}$/.test(name) ? name : fallback;
}

// Runs `items` through `worker` with at most `limit` in flight at once.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(runners);
  return results;
}

async function generateSceneImage(apiKey, imageModel, imagePrompt) {
  const fullPrompt = `${imagePrompt}\n\n${IMAGE_STYLE_SUFFIX}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: controller.signal,
    });

    if (!r.ok) {
      const errText = await r.text();
      return { image: null, error: `Gemini image error: ${errText.slice(0, 300)}` };
    }

    const data = await r.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find((p) => p.inline_data || p.inlineData);
    const inline = imgPart && (imgPart.inline_data || imgPart.inlineData);

    if (!inline || !inline.data) {
      return { image: null, error: "이미지 응답이 비어있습니다." };
    }

    const mimeType = inline.mime_type || inline.mimeType || "image/png";
    return { image: `data:${mimeType};base64,${inline.data}`, error: null };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "이미지 생성 시간 초과" : (e && e.message) || "이미지 생성 실패";
    return { image: null, error: msg };
  } finally {
    clearTimeout(timeout);
  }
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
    const { korean, photos, model, imageModel, generateImages } = req.body || {};

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

    // Only allow a conservative model-name character set — these values are interpolated into a URL.
    const modelName = safeModelName(model, DEFAULT_TEXT_MODEL);
    const imageModelName = safeModelName(imageModel, DEFAULT_IMAGE_MODEL);

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

    // Parse the JSON here (rather than only on the client) so we can pull out the
    // scenes and attach a generated image to each one before responding.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // If parsing fails, fall back to the old behavior: just forward the raw text
      // and let the client handle/display the parse error as before.
      res.status(200).json({ text });
      return;
    }

    const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    const shouldGenerateImages = generateImages !== false && rawScenes.length > 0;

    let scenes = rawScenes.map((s) => ({
      text: typeof s?.text === "string" ? s.text : "",
      imagePrompt: typeof s?.imagePrompt === "string" ? s.imagePrompt : "",
      image: null,
      error: null,
    }));

    if (shouldGenerateImages) {
      const results = await runWithConcurrency(scenes, IMAGE_CONCURRENCY, (scene) =>
        scene.imagePrompt
          ? generateSceneImage(apiKey, imageModelName, scene.imagePrompt)
          : Promise.resolve({ image: null, error: "no imagePrompt" })
      );
      scenes = scenes.map((scene, i) => ({ ...scene, image: results[i].image, error: results[i].error }));
    }

    parsed.scenes = scenes;

    // We forward the parsed object back to the client (with images attached).
    // The Gemini API key itself never leaves this server.
    res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Unknown server error" });
  }
}
