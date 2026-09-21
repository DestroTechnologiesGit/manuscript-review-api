import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const WRITER_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const REVIEWER_MODEL = process.env.OPENAI_MODEL || "gpt-5";
/* Output ceiling. Rewrites quote the text they replace, so the fix step needs
   far more room than the review step, which only reports. Current models allow
   up to 128k; 32k is a safe default that still finishes a large chunk. */
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 32000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const REVIEW_EFFORT = process.env.REVIEW_EFFORT || "high";

/* ---------------------------------------------------------------------------
   Which models the page may offer.

   Only chat/reasoning models belong here — the providers also serve image,
   audio, embedding and moderation models that cannot read a manuscript. We
   ask each provider what this key can actually reach, then keep the ones that
   match these patterns, so the dropdowns never list a model you cannot use.
--------------------------------------------------------------------------- */
const OPENAI_USABLE = /^(gpt-[456789]|o[34])/;      // gpt-5.5, gpt-5, o3, o4-mini …
const OPENAI_EXCLUDE = /audio|realtime|search|image|tts|whisper|embed|moderation|transcribe|codex|deep-research|computer-use|chat-latest/;
const ANTHROPIC_USABLE = /^claude-/;

// Shown when a provider's list call fails, so the page still works offline.
const FALLBACK = {
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.1", "gpt-5", "gpt-5-mini", "o3"],
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
};

// Plain-English notes for the models people are most likely to pick.
const NOTES = {
  "gpt-5.5": "Newest OpenAI. Most thorough reviewer.",
  "gpt-5": "Strong reviewer, cheaper than 5.5.",
  "gpt-5-mini": "Fast and cheap. Misses subtler problems.",
  "o3": "Reasoning model. Good on facts and logic.",
  "claude-opus-5": "Best writer. Follows your directions closely.",
  "claude-sonnet-5": "Faster and cheaper than Opus.",
  "claude-haiku-4-5": "Cheapest. Best for small, mechanical fixes.",
};

let MODEL_LIST = { openai: [], anthropic: [] };

async function loadModels() {
  const decorate = (ids) => ids.map((id) => ({ id, note: NOTES[id] || "" }));

  if (openai) {
    try {
      const page = await openai.models.list();
      const ids = page.data
        .map((m) => m.id)
        .filter((id) => OPENAI_USABLE.test(id) && !OPENAI_EXCLUDE.test(id))
        // Drop dated snapshots (gpt-5-2025-08-07) — the bare alias covers them.
        .filter((id) => !/-\d{4}-\d{2}-\d{2}$/.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      MODEL_LIST.openai = decorate(ids.length ? ids : FALLBACK.openai);
    } catch (err) {
      console.warn("Could not list OpenAI models, using a built-in list:", err.message);
      MODEL_LIST.openai = decorate(FALLBACK.openai);
    }
  }

  try {
    const page = await claude.models.list({ limit: 50 });
    const ids = page.data.map((m) => m.id).filter((id) => ANTHROPIC_USABLE.test(id));
    MODEL_LIST.anthropic = decorate(ids.length ? ids : FALLBACK.anthropic);
  } catch (err) {
    console.warn("Could not list Anthropic models, using a built-in list:", err.message);
    MODEL_LIST.anthropic = decorate(FALLBACK.anthropic);
  }
}

// Which provider serves a given model id, or null if we do not offer it.
function providerOf(id) {
  if (MODEL_LIST.openai.some((m) => m.id === id)) return "openai";
  if (MODEL_LIST.anthropic.some((m) => m.id === id)) return "anthropic";
  return null;
}

/* Pick the model and the provider for one call. The browser may name any model
   from either list for either job, so routing follows the model, not the role.
   An unknown or unreachable name falls back to that role's default. */
function resolve(role, requested) {
  let provider = providerOf(requested);
  if (provider === "openai" && !openai) provider = null; // named it, but no key
  if (provider) return { model: requested, provider };

  const canReview = role === "review" && openai;
  return canReview
    ? { model: REVIEWER_MODEL, provider: "openai" }
    : { model: WRITER_MODEL, provider: "anthropic" };
}

const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Claude cannot make the fixes without it.");
}
if (!hasOpenAI) {
  console.warn(
    "Warning: OPENAI_API_KEY is not set. Reviews will fall back to Claude, which is the thing\n" +
    "         this app exists to avoid. Add the key so a second model checks the work."
  );
}
if (!APP_PASSWORD) {
  console.warn("Warning: APP_PASSWORD is not set. Anyone who can reach this server can spend your API credits.");
}

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const openai = hasOpenAI ? new OpenAI() : null; // reads OPENAI_API_KEY

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function passwordOk(req) {
  if (!APP_PASSWORD) return true;
  const got = Buffer.from(String(req.get("x-app-password") || ""));
  const want = Buffer.from(APP_PASSWORD);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Read JSON out of a model's reply, tolerating a code fence or a stray sentence.
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = text.search(/[\[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  return undefined;
}

/* Rescue the complete objects from a reply that was cut off mid-array.

   A truncated reply is still mostly good work: the edits before the cut are
   whole and usable. Rather than throw the call away and charge for it twice,
   walk the array and keep every element that closed cleanly. Returns the
   salvaged items, or undefined if nothing usable survived. */
function salvageArray(text, key) {
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return undefined;
  const open = text.indexOf("[", at);
  if (open < 0) return undefined;

  const items = [];
  let depth = 0, inStr = false, esc = false, startedAt = -1;

  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (c === "{") { if (depth === 0) startedAt = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && startedAt >= 0) {
        try { items.push(JSON.parse(text.slice(startedAt, i + 1))); } catch {}
        startedAt = -1;
      }
    } else if (c === "]" && depth === 0) break; // array closed normally
  }
  return items.length ? items : undefined;
}

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

const SYSTEM = "Reply with only valid JSON. No other text before or after it.";

/* ---------------------------------------------------------------------------
   The reviewer: OpenAI. A different company's model reads the manuscript and
   says what is wrong with it. It never writes the book, so it has no stake in
   defending the prose it is judging.
--------------------------------------------------------------------------- */
async function runOpenAI(prompt, signal, model, role) {
  // Only reasoning models accept `reasoning`; gpt-4.x rejects it outright.
  const reasons = /^(gpt-[56789]|o[34])/.test(model);
  const response = await openai.responses.create(
    {
      model,
      instructions: SYSTEM,
      input: prompt,
      ...(reasons ? { reasoning: { effort: REVIEW_EFFORT } } : {}),
      max_output_tokens: MAX_TOKENS,
    },
    { signal }
  );

  const u = response.usage || {};
  console.log(
    `[${new Date().toISOString()}] ${role} ${model} ` +
    `in=${u.input_tokens} out=${u.output_tokens} status=${response.status}`
  );

  let cutOff = false;
  if (response.status === "incomplete") {
    const reason = response.incomplete_details && response.incomplete_details.reason;
    if (reason === "content_filter") throw { http: 422, code: "refused" };
    if (reason === "max_output_tokens") cutOff = true;
  }
  return { text: response.output_text || "", cutOff };
}

/* ---------------------------------------------------------------------------
   The writer: Claude. It only ever sees fixes the publisher approved, and it
   rewrites the text. It is never asked to judge its own work.
--------------------------------------------------------------------------- */
async function runAnthropic(prompt, signal, model, role) {
  const stream = claude.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    },
    { signal }
  );
  const msg = await stream.finalMessage();

  console.log(
    `[${new Date().toISOString()}] ${role} ${model} ` +
    `in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens} stop=${msg.stop_reason}`
  );

  if (msg.stop_reason === "refusal") throw { http: 422, code: "refused" };

  return {
    text: msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    cutOff: msg.stop_reason === "max_tokens",
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    models: MODEL_LIST,
    defaults: {
      reviewer: hasOpenAI ? REVIEWER_MODEL : WRITER_MODEL,
      writer: WRITER_MODEL,
    },
    hasOpenAI,
  });
});

async function handleModelCall(req, res) {
  if (!passwordOk(req)) return fail(res, 401, "unauthorized", "Wrong or missing password.");

  const prompt = req.body && req.body.prompt;
  const role = req.body && req.body.role === "review" ? "review" : "fix";
  if (typeof prompt !== "string" || !prompt.trim()) return fail(res, 400, "bad_request", "Missing prompt.");
  if (prompt.length > 600_000) return fail(res, 413, "too_large", "Prompt is too large.");

  // If the browser presses Stop (closes the request), stop paying for the answer.
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });

  const { model, provider } = resolve(role, req.body && req.body.model);
  const run = provider === "openai" ? runOpenAI : runAnthropic;

  try {
    const { text, cutOff } = await run(prompt, controller.signal, model, role);
    let data = parseJson(text);
    let partial = false;

    // A reply cut off mid-array still holds finished work. Keep what closed.
    if (data === undefined && cutOff) {
      const key = role === "review" ? "issues" : "edits";
      const items = salvageArray(text, key);
      if (items) { data = { [key]: items }; partial = true; }
    }

    if (data === undefined) {
      return cutOff
        ? fail(res, 502, "truncated",
            `${model} ran out of room before it finished. Raise MAX_TOKENS, or use a shorter manuscript part.`)
        : fail(res, 502, "invalid_json", `${model} didn't reply with valid JSON.`);
    }

    if (partial) {
      const n = data[role === "review" ? "issues" : "edits"].length;
      console.log(`  salvaged ${n} complete ${role === "review" ? "issues" : "edits"} from a truncated reply`);
    }
    res.json({ data, model, by: provider, partial });
  } catch (err) {
    if (controller.signal.aborted) return; // the browser already left

    // Errors this file threw on purpose, with a code the page already knows.
    if (err && err.http) {
      const copy = {
        refused: `${model} declined this request.`,
        invalid_json: "The reply was cut off. Raise MAX_TOKENS or use a shorter manuscript part.",
      };
      return fail(res, err.http, err.code, copy[err.code] || "The model call failed.");
    }

    console.error(err);
    const status = err && err.status;
    if (status === 401 || status === 403) {
      return fail(res, 500, "server_key",
        provider === "openai"
          ? "The OpenAI API key is missing or invalid. Check OPENAI_API_KEY."
          : "The Anthropic API key is missing or invalid. Check ANTHROPIC_API_KEY.");
    }
    if (status === 404) {
      return fail(res, 400, "bad_request",
        `Your account can't reach ${model}. Choose a different model.`);
    }
    if (status === 429) return fail(res, 429, "rate_limited", `${model} hit its rate limit.`);
    if (status === 529 || status === 503) return fail(res, 503, "overloaded", `${model} is overloaded.`);
    if (status === 400 || status === 413) return fail(res, 400, "bad_request", err.message || "Bad request.");
    return fail(res, 502, "upstream_error", "The API call failed.");
  }
}

app.post("/api/model", handleModelCall);

// The old single-model route, kept so an older saved page still works.
app.post("/api/claude", (req, res) => {
  req.body = { ...(req.body || {}), role: "fix" };
  return handleModelCall(req, res);
});

await loadModels();

app.listen(PORT, () => {
  console.log(`Manuscript review running at http://localhost:${PORT}`);
  console.log(`  Reviewer default: ${hasOpenAI ? REVIEWER_MODEL : WRITER_MODEL + " — no OpenAI key, see warning above"}`);
  console.log(`  Writer default:   ${WRITER_MODEL}`);
  console.log(`  Choosable models: ${MODEL_LIST.openai.length} OpenAI, ${MODEL_LIST.anthropic.length} Anthropic`);
});
