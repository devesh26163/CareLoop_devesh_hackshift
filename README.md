# CareLoop backend (Cloudflare Worker)

A ~130-line Worker that holds your Anthropic API key so the public page never sees it.
The page sends a prompt (and, for prescriptions, one photo); the Worker calls Claude and
returns the parsed JSON. Nothing is stored or logged.

## Deploy
The easy way is the GitHub Actions workflow in the repo root; see the main README. To deploy by hand instead (free tier is enough):
1. Install Node.js, then in this `backend/` folder run `npx wrangler login`.
2. Add `ALLOWED_ORIGIN = "https://<your-github-username>.github.io"` under a `[vars]` heading in `wrangler.toml`.
3. Add your key: `npx wrangler secret put ANTHROPIC_API_KEY` (paste it when asked).
4. Run `npx wrangler deploy`. It prints a URL like `https://careloop-api.<you>.workers.dev`.
5. In `index.html`, set `const API_URL='<that URL>'`, commit, and push.

## Test it
    curl -X POST https://careloop-api.<you>.workers.dev \
      -H "Origin: https://<you>.github.io" -H "Content-Type: application/json" \
      -d '{"prompt":"Reply with only this JSON: {\"ok\":true}"}'
Expect `{"value":{"ok":true}}`.

## Protect your key and your bill
- Set a monthly spend limit on the API key in the Anthropic Console.
- The origin check and the built-in limit (20 requests per 10 minutes per IP, per Worker
  instance) only slow casual abuse; anyone can fake an Origin header from a script. For a real
  cap, add a Cloudflare rate-limiting rule on the Worker's route.
- Never put the key in `index.html` or commit it to the repo.

## Privacy
Prescription photos pass through this Worker to Anthropic's API. Tell users that, and check
the data-handling terms that apply to your API account before using real patient data.
This is a demo: it is not a medical device and has not been reviewed for health-data law.
