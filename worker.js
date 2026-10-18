// CareLoop backend: a tiny Cloudflare Worker that keeps your Anthropic API key
// off the public page. The page POSTs { prompt, image? } and gets { value } back,
// where value is the parsed JSON the model returned.
//
// Secrets / vars (see backend/README.md):
//   ANTHROPIC_API_KEY  secret, required
//   ALLOWED_ORIGIN     e.g. https://<you>.github.io  (required in production)
//   MODEL              optional, defaults to claude-sonnet-5-5
//
// Nothing is stored or logged here: the image and prompt only live in memory
// for the length of one request.

const MAX_PROMPT_CHARS = 8000;
const MAX_IMAGE_B64_CHARS = 5_000_000; // ~3.7 MB of image; the page shrinks photos first
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// Best-effort per-IP limit. It is per Worker instance, so treat it as a speed bump
// and add a Cloudflare rate-limiting rule for a real cap (see README).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQS = 20;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_REQS;
}

function cors(env) {
  const allow = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function reply(env, origin, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });
}

// Pull a JSON value out of the model's text, tolerating stray fences or chatter.
function extractJson(text) {
  const t = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(t);
  } catch (_) {}
  const starts = [t.indexOf("["), t.indexOf("{")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("no json");
  const a = Math.min(...starts);
  const b = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  return JSON.parse(t.slice(a, b + 1));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (request.method !== "POST") return reply(env, origin, 405, { error: "method_not_allowed" });

    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) {
      return reply(env, origin, 403, { error: "origin_not_allowed" });
    }
    if (!env.ANTHROPIC_API_KEY) return reply(env, origin, 500, { error: "server_not_configured" });

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (limited(ip)) return reply(env, origin, 429, { error: "rate_limited" });

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return reply(env, origin, 400, { error: "bad_json" });
    }

    const prompt = body && body.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      return reply(env, origin, 400, { error: "bad_prompt" });
    }

    const content = [];
    const img = body.image;
    if (img !== undefined && img !== null) {
      if (
        typeof img !== "object" ||
        !ALLOWED_TYPES.has(img.media_type) ||
        typeof img.data !== "string" ||
        !img.data.length ||
        img.data.length > MAX_IMAGE_B64_CHARS ||
        !/^[A-Za-z0-9+/=]+$/.test(img.data)
      ) {
        return reply(env, origin, 400, { error: "bad_image" });
      }
      content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    }
    content.push({ type: "text", text: prompt });

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.MODEL || "claude-sonnet-5-5",
          max_tokens: 2000,
          system: "You are the reading and checking engine of a patient-support app. Reply with only valid JSON exactly as the user's instructions describe. No markdown, no commentary.",
          messages: [{ role: "user", content }],
        }),
        signal: AbortSignal.timeout(55000),
      });
    } catch (_) {
      return reply(env, origin, 504, { error: "upstream_timeout" });
    }

    if (upstream.status === 429) return reply(env, origin, 429, { error: "rate_limited" });
    if (!upstream.ok) return reply(env, origin, 502, { error: "upstream_error" });

    let data;
    try {
      data = await upstream.json();
    } catch (_) {
      return reply(env, origin, 502, { error: "upstream_error" });
    }

    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    try {
      return reply(env, origin, 200, { value: extractJson(text) });
    } catch (_) {
      return reply(env, origin, 502, { error: "bad_model_output" });
    }
  },
};
