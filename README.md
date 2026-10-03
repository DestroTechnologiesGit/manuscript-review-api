# Manuscript review

Two models, doing two different jobs.

**One model reviews. A different one rewrites.** You pick both. The reviewer never writes the book,
so it has no stake in defending the prose it is judging. That is the whole point: a model asked to
review its own writing skips over big problems, and you only find out when it is too late.

Nothing is automated. The reviewer hands you a list, you decide what happens to each item, and only
then does the rewriter touch the text.

Everything lives in `manuscript-review-api/`.

## How a round works

1. **Upload** a manuscript (.docx, .pdf, .txt, .md) or paste the text.
2. **Pick who does what.** Two dropdowns on the upload page: one model reads, another rewrites.
   They list every model your API keys can actually reach, and remember your last choice. Pick the
   same model for both and the page warns you, because a model reviewing its own writing is the
   blind spot this tool exists to avoid.
3. **The reviewer reads it** and reports what is wrong. Every review covers all three, always:
   editing, proofreading, and fact-checking.
4. **You decide, item by item.** Fix, or Leave as is. On anything you mark Fix you can add your own
   direction — "remove this, and don't mention periods for women" — and the rewriter follows your wording
   over the suggested fix. Leave the box empty and it uses the suggestion. Fix all / Leave all are
   there when the list is long.
5. **Press Apply.** Only then does the rewriter touch the text, and only the items you approved.
6. **Review the result.** Every change is a separate line you can untick to undo. Download the
   revised manuscript and a change report.
7. **Send it back for another review.** The reviewer reads the new version and tells you what is
   still wrong, including anything the last round broke. You approve the next set. Repeat until
   you are happy. A round counter shows what each pass found and fixed.

   Rounds remember what you already settled. The reviewer is told which items you left as is and
   which passages were already rewritten, and is asked not to raise them again. If it does anyway,
   the item is set to Leave as is, marked "Raised before", and moved to the bottom of the list. The
   rewriter is told to leave earlier rewrites alone. Without this memory, the two models keep
   rewording each other's sentences and the loop never finishes.

The loop only advances when you press the button.

## Run it on your computer

1. Install Node.js 18 or newer.
2. In `manuscript-review-api/`, run `npm install`.
3. Copy `.env.example` to `.env` and fill in:
   - `OPENAI_API_KEY` — the reviewer ([platform.openai.com](https://platform.openai.com))
   - `ANTHROPIC_API_KEY` — the writer ([console.anthropic.com](https://console.anthropic.com))
   - `APP_PASSWORD` — pick anything; the page asks for it once per session.
4. Run `npm start` and open http://localhost:3000.

The startup log tells you which model has which job. If `OPENAI_API_KEY` is missing the app still
runs, but Claude reviews its own work — the page shows a warning when that happens, because it is
the failure mode this tool exists to prevent.

## Put it online

Any Node host works (Render, Railway, Fly.io, a VPS). Set the same values as environment variables
in the host's settings and use `npm start` as the start command. Keep `APP_PASSWORD` set, otherwise
anyone with the link can spend your API credits.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-5` | Which reviewer the dropdown starts on. |
| `CLAUDE_MODEL` | `claude-opus-5` | Which rewriter the dropdown starts on. |
| `REVIEW_EFFORT` | `high` | How hard the reviewer thinks. `low`, `medium`, `high`, `xhigh`, `max`. |
| `MAX_TOKENS` | `32000` | Longest reply allowed. The fix step needs the most room, because a rewrite quotes the text it replaces. |

Manuscripts are split into parts of roughly 35KB (`splitChunks` in `public/index.html`). Each part
is one review call and one fix call. Parts are deliberately smaller than the model's input limit,
because the fix step's reply quotes the text it changes and has to fit in `MAX_TOKENS`.

### If a reply gets cut off

The fix step writes more than the review step, so it is the one that runs out of room. When a reply
is cut off mid-list, the server keeps every edit that finished and tells the page, which says how
many parts were affected — you do not lose the whole call. To get the rest, send the manuscript back
for another review round, or raise `MAX_TOKENS`.

## How it works

- `POST /api/model` takes `{ prompt, role }`. `role: "review"` goes to OpenAI, `role: "fix"` goes to
  Anthropic. Returns `{ data, model }` or `{ error: { code, message } }`. Both API keys stay on the
  server and are never sent to the browser.
- `GET /api/config` returns the models each key can reach, asked of both providers at startup
  (with a built-in list as a fallback), plus the defaults. The page builds its dropdowns from it.
- Requests name their model. The server routes by that model's provider, so either job can go to
  either company, and it ignores any model it did not offer.
- The prompts are in `public/index.html` (`reviewPrompt` and `applyPrompt`). The review prompt tells
  the reviewer it did not write the text and should not be encouraging; from round 2 on it also lists
  what earlier rounds settled (`settledBlock`). `markRepeats` catches repeats the reviewer raises anyway.
- Fixes come back as small find-and-replace edits applied in the browser, so every change can be
  undone individually.
- Word files are read as plain text, so the download is a .txt without Word formatting.
- Token usage for each call is printed in the server log, labelled `review` or `fix`.
