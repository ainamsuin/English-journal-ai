// Vercel Serverless Function
// This runs on the server, never in the user's browser.
// The Gemini API key lives only in the GEMINI_API_KEY environment variable
// (set it in your Vercel project's Settings → Environment Variables — never
// commit it to a file or to git). Gemini is used for the text generation call
// (easyEnglish, naturalEnglish, vocabulary, scenes, etc).
//
// Scene images are generated separately via Cloudflare Workers AI (SDXL-Lightning,
// which supports explicit width/height — scenes are generated at 1280x720),
// which has its own, independent free daily quota. Set these two environment
// variables to enable it:
//   CLOUDFLARE_ACCOUNT_ID  — your Cloudflare account ID
//   CLOUDFLARE_API_TOKEN   — a Workers AI API token (Cloudflare dashboard → Manage
//                            Account → Account API Tokens → "Create a Workers AI
//                            API Token")
// If either is missing, text generation still works — scene images are just
// skipped with a clear per-scene error instead of failing the whole request.

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
  '  "expressions": [{"phrase": "a short useful English expression or phrase drawn from or relevant to the entry", "meaning": "a short, natural Korean explanation of what this expression means / when to use it"}],',
  '  "vocabulary": [{"word": "english word", "meaning": "short Korean definition"}],',
  '  "koreanExpressions": [{"phrase": "a natural or idiomatic Korean expression/phrase taken directly from the diary text itself", "meaning": "a clear English explanation of what this Korean expression means and when/how it is used"}],',
  '  "koreanVocabulary": [{"word": "a useful or notable Korean word taken directly from the diary text", "meaning": "a short English definition"}],',
  '  "speakScript": "a 30-60 second first-person spoken script in English, suitable for reading aloud on camera, starting with a casual greeting like \'Hi everyone.\'",',
  '  "koreanSpeakScript": "a natural Korean version of the same spoken script — same content, structure, and casual first-person tone as speakScript, written for reading aloud in Korean (not a stiff literal translation)",',
  '  "youtubeTitle": "a short catchy title for a vlog/short based on this entry",',
  '  "hashtags": ["5 short hashtag strings without the # symbol"],',
  '  "scenes": [{"text": "the exact original Korean sentence(s) from the diary this scene covers", "easyCaption": "a short, simple English translation of just this scene, matching the tone/level of easyEnglish (A2 level)", "naturalCaption": "a natural, fluent English translation of just this scene, matching the tone of naturalEnglish", "imagePrompt": "a concrete, specific English description of the subject, setting, action and mood of this single scene, written for an image-generation model — describe WHAT is depicted, not an art style"}]',
  "}",
  "",
  "Keep expressions to 3-5 entries and vocabulary to 5-8 entries. Base everything on the specific content of the diary (and photos if provided) — be concrete, not generic.",
  "",
  "\"koreanExpressions\" and \"koreanVocabulary\" are the reverse direction: pick natural, idiomatic, or otherwise notable Korean phrasing/words that actually appear in the diary text, and explain them in English for someone learning Korean. Keep koreanExpressions to 3-5 entries and koreanVocabulary to 5-8 entries. Do not just translate the English expressions/vocabulary back — choose genuinely interesting Korean phrasing from the original entry.",
  "",
  "For \"scenes\": break the diary into a sequence of situations, in order, covering the whole entry. As a general rule, use one scene per sentence, but when two or more consecutive sentences describe a single continuous situation, merge them into one scene instead of repeating near-duplicate images. \"easyCaption\" and \"naturalCaption\" must translate ONLY that scene's Korean text (not the whole diary) — keep them short enough to read comfortably as a video subtitle (roughly one short sentence). Each imagePrompt must describe only the concrete content of that moment (people, objects, setting, action, mood) — do not mention art style, medium, or color palette; that will be applied separately.",
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
const DEFAULT_CF_IMAGE_MODEL = "@cf/bytedance/stable-diffusion-xl-lightning";
const SCENE_IMAGE_WIDTH = 1280;
const SCENE_IMAGE_HEIGHT = 720;
const CF_PROMPT_MAX_LEN = 2048; // conservative cap shared across Cloudflare image models
const IMAGE_CONCURRENCY = 3;
const IMAGE_TIMEOUT_MS = 30_000;
const IMAGE_MAX_ATTEMPTS = 3;
const IMAGE_GENERATION_BUDGET_MS = 45_000; // leaves headroom under maxDuration for the text call + response

// --- very small in-memory rate limiter -------------------------------------------------
// Note: serverless instances are ephemeral and can scale to multiple copies, so this is a
// best-effort speed bump, not a hard guarantee. It stops a single runaway client/script
// from burning through your API quota in a tight loop.
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

// Cloudflare Workers AI model IDs look like "@cf/black-forest-labs/flux-1-schnell",
// which needs slashes and an "@" allowed on top of the usual safe character set.
function safeCFModelName(name, fallback) {
  return typeof name === "string" && /^@[a-zA-Z0-9]+\/[a-zA-Z0-9._/-]{1,80}$/.test(name) ? name : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pulls a short human-readable message out of a Gemini error body, which is
// normally a JSON blob like {"error":{"code":429,"message":"...","status":"..."}}.
function extractGeminiErrorMessage(errText) {
  try {
    const parsed = JSON.parse(errText);
    return (parsed && parsed.error && parsed.error.message) || errText;
  } catch {
    return errText;
  }
}

// Cloudflare error bodies look like {"success":false,"errors":[{"code":..,"message":".."}],...}
function extractCloudflareErrorMessage(errText) {
  try {
    const parsed = JSON.parse(errText);
    const first = parsed && Array.isArray(parsed.errors) && parsed.errors[0];
    return (first && first.message) || errText;
  } catch {
    return errText;
  }
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

// Generates one scene image via Cloudflare Workers AI at a fixed 1280x720 resolution.
// Returns { image: dataURL|null, error: string|null }. Retries on 429 with backoff.
async function generateSceneImage(accountId, apiToken, cfModel, imagePrompt, deadline) {
  const fullPrompt = `${imagePrompt} ${IMAGE_STYLE_SUFFIX}`.slice(0, CF_PROMPT_MAX_LEN);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${cfModel}`;

  let lastError = "이미지 생성 실패";

  for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) {
      return { image: null, error: "시간이 부족해 재시도를 중단했어요. 잠시 후 다시 시도해주세요." };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({
          prompt: fullPrompt,
          negative_prompt: "text, letters, words, watermark, logo, signature, blurry, distorted, photorealistic, 3d render",
          width: SCENE_IMAGE_WIDTH,
          height: SCENE_IMAGE_HEIGHT,
          num_steps: 8,
          seed: Math.floor(Math.random() * 1_000_000),
        }),
        signal: controller.signal,
      });

      if (r.status === 429) {
        const errText = await r.text();
        lastError = "이미지 생성 할당량(quota)을 초과했어요. Cloudflare Workers AI 사용량 한도를 확인해주세요. (" + extractCloudflareErrorMessage(errText).slice(0, 200) + ")";
        const header = r.headers && r.headers.get && r.headers.get("retry-after");
        const retrySecs = header ? parseInt(header, 10) : NaN;
        const waitMs = !isNaN(retrySecs) ? retrySecs * 1000 : 1500 * attempt;
        if (attempt < IMAGE_MAX_ATTEMPTS && Date.now() + waitMs < deadline) {
          await sleep(waitMs);
          continue;
        }
        return { image: null, error: lastError };
      }

      if (!r.ok) {
        const errText = await r.text();
        return { image: null, error: `Cloudflare image error: ${extractCloudflareErrorMessage(errText).slice(0, 300)}` };
      }

      // Cloudflare's REST API usually wraps image output as base64 inside JSON
      // ({ result: { image: "..." } }), but some models return the raw image
      // bytes directly with an image/* content-type. Handle both.
      const contentType = (r.headers.get("content-type") || "").toLowerCase();
      if (contentType.startsWith("image/")) {
        const buf = Buffer.from(await r.arrayBuffer());
        return { image: `data:${contentType.split(";")[0]};base64,${buf.toString("base64")}`, error: null };
      }

      const data = await r.json();
      if (!data || data.success === false || !data.result || !data.result.image) {
        const msg = (data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) || "이미지 응답이 비어있습니다.";
        return { image: null, error: msg };
      }

      // Some Cloudflare image models return a plain base64 string (no data: prefix).
      return { image: `data:image/jpeg;base64,${data.result.image}`, error: null };
    } catch (e) {
      lastError = e && e.name === "AbortError" ? "이미지 생성 시간 초과" : (e && e.message) || "이미지 생성 실패";
      if (attempt < IMAGE_MAX_ATTEMPTS && Date.now() + 1000 * attempt < deadline) {
        await sleep(1000 * attempt);
        continue;
      }
      return { image: null, error: lastError };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { image: null, error: lastError };
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

  // Scene images use Cloudflare Workers AI, entirely separate from the Gemini text call.
  const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const cfApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const cfConfigured = Boolean(cfAccountId && cfApiToken);

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
    const cfModelName = safeCFModelName(imageModel, DEFAULT_CF_IMAGE_MODEL);

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
      res.status(geminiRes.status).json({ error: `Gemini error: ${extractGeminiErrorMessage(errText).slice(0, 400)}` });
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
      easyCaption: typeof s?.easyCaption === "string" ? s.easyCaption : "",
      naturalCaption: typeof s?.naturalCaption === "string" ? s.naturalCaption : "",
      imagePrompt: typeof s?.imagePrompt === "string" ? s.imagePrompt : "",
      image: null,
      error: null,
    }));

    if (shouldGenerateImages) {
      if (!cfConfigured) {
        scenes = scenes.map((scene) => ({
          ...scene,
          error: "서버에 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN이 설정되어 있지 않아 이미지를 생성할 수 없어요.",
        }));
      } else {
        const imageDeadline = Date.now() + IMAGE_GENERATION_BUDGET_MS;
        const results = await runWithConcurrency(scenes, IMAGE_CONCURRENCY, (scene) =>
          scene.imagePrompt
            ? generateSceneImage(cfAccountId, cfApiToken, cfModelName, scene.imagePrompt, imageDeadline)
            : Promise.resolve({ image: null, error: "no imagePrompt" })
        );
        scenes = scenes.map((scene, i) => ({ ...scene, image: results[i].image, error: results[i].error }));
      }
    }

    parsed.scenes = scenes;

    // We forward the parsed object back to the client (with images attached).
    // Neither the Gemini API key nor the Cloudflare API token ever leave this server.
    res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || "Unknown server error" });
  }
}
