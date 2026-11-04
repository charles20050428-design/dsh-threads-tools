# dsh-threads-tools

> Threads automation as agent tools for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).
> Built on Playwright, driving a **real, already-logged-in browser session** instead of an API.

Threads has no public API for personal accounts, so most "automate Threads" attempts end up
with a throwaway script. This project turns it into a reusable DSH plugin: seven tools an
agent can call directly, with state, quota and idempotency handled for you.

**Package name:** `dsh-threads-browser-local`
**License:** MIT

---

## Why this exists

The goal was a fish that reads its own Threads notifications, replies to people, and posts —
without me babysitting it. That needs three things a plain LLM cannot do:

1. **See the real page.** Notifications live behind a login.
2. **Act on it.** Click, type, attach an image, publish — and know whether it worked.
3. **Not be a spam bot.** Dedupe, rate-limit, one reply per person per day.

The plugin provides (2) and (3); DSH provides the agent loop and (1)'s session.

---

## Tools

| Tool | What it does |
| --- | --- |
| `threads_status` | Login state, current page, today's quota, configured handle. Call this first. |
| `threads_notifications` | Read **Activity → Replies**: who replied to my comments. Returns only unanswered ones by default. |
| `threads_reply` | Reply to one activity item. Text, image, or both. |
| `threads_peek` | Read-only: open one reply page, return visible text + large image URLs (for image-only replies). |
| `threads_feed` | Read the home feed — other people's posts, with post URLs. |
| `threads_comment` | Comment on someone else's post. |
| `threads_post` | Publish a new thread, optionally with an image. |

All tools accept `imagePath` as an absolute path where relevant, and always resolve to
`{ tool, result }` rather than throwing — a failed click returns `{ ok: false, error }`
so the agent can retry or change its plan.

---

## Requirements

- **Node.js** >= 22.13
- **DSH** 0.2.x (the plugin is a DSH tool bundle, not a standalone library)
- **Microsoft Edge** — the controller launches Chromium with `channel: "msedge"`
- `playwright-core` resolvable from the plugin or from your DSH profile
- A Threads account you are willing to log into on this machine

---

## Install

1. Clone this repo somewhere local:

   ```bash
   git clone <your-repo-url> dsh-threads-tools
   ```

2. Install Playwright's driver into the plugin (or into your DSH profile — the loader tries
   the plugin first, then `<DSH_PROFILE_DIR>/node_modules`):

   ```bash
   cd dsh-threads-tools
   npm install playwright-core
   ```

3. Register the plugin in your DSH profile. Edit
   `%USERPROFILE%\.dsh\profiles\desktop\package.json` (Windows) or
   `~/.dsh/profiles/<profile>/package.json`:

   ```json
   {
     "dependencies": {
       "dsh-threads-browser-local": "link:/absolute/path/to/dsh-threads-tools"
     },
     "dsh": {
       "profile": {
         "bundles": ["...all your other bundles...", "dsh-threads-browser-local"]
       }
     }
   }
   ```

   The name must match `package.json`; adding it to `bundles` is what actually loads it.

4. Restart DSH.

5. Tell the plugin who you are, then log in once:

   ```bash
   setx THREADS_ME your_handle      # Windows, no @
   export THREADS_ME=your_handle    # macOS / Linux
   ```

   Restart DSH so it inherits the variable. Then call `threads_status` — the first call
   opens an Edge window; log into Threads there. The profile persists, so you only do this once.

6. Sanity check without touching a browser:

   ```bash
   node test/smoke.mjs   # → OK — 7 tools registered
   ```

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `THREADS_ME` | *(empty)* | Your handle without `@`. Used to tell "my own comment" apart from everyone else's. |
| `THREADS_PROFILE_DIR` | `~/.dsh/threads-browser/profile` | Browser profile directory (holds the login session). |
| `DSH_PROFILE_DIR` | `~/.dsh/profiles/desktop` | Where the loader looks for `playwright-core`. |

Runtime state (replied accounts, seen replies, daily quota) lives in
`~/.dsh/threads-browser/state.json` — **never commit it**, and it is git-ignored here.

---

## How it works

**Session layer.** `chromium.launchPersistentContext()` on the Edge channel. Login happens
once by hand; subsequent runs reuse the same profile. A dead context is detected and
relaunched rather than caching a broken handle.

**DOM heuristics.** Threads ships no stable selectors, so the controller anchors on what the
UI actually renders:

- `[data-pressable-container="true"]` — every post/notification card
- `svg > title` text (`回覆`, `發佈`) — the correct icon button, since the clickable target is
  the SVG's grandparent
- `[data-lexical-editor="true"]` — the composer; when it is covered by a placeholder overlay,
  focus it from the DOM instead of clicking

**Reply-state detection.** Two independent signals, because both lie sometimes:

- On the activity list: the reply icon at the bottom of a card is a filled check (zero
  `<path>` children) when answered, and a hollow bubble (one `<path>`) when not.
- On a thread page: my reply sits directly above (recent sort) or below (ascending) the
  comment it answers — so "is the neighbouring block mine" is the signal.

**Don't disappear behind the sort order.** Post pages are loaded with
`?sort_order=recent&filter_type=all`. The default "top" sort buries fresh replies far enough
down that replying silently misses.

**Guardrails, on purpose.** The tools are meant to be used by a personality, not a marketing
funnel, so the plugin limits itself: 60 replies/comments per day, one reply per account per
day, and a bounded `seen` cache (1200 URLs) so re-reading the same notification costs nothing.
Every write action is verified after the fact — the tool polls for "已發佈" or an emptied
composer before reporting success, instead of assuming the click worked.

---

## Limitations

- **Chinese (Traditional) UI only.** Button matching uses literal strings such as `回覆`,
  `發佈`, `新串文`, `附加影音內容`, `尚無回覆`. Localizing means centralizing those strings —
  a PR would be welcome.
- **DOM-coupled.** Threads can change markup at any time. That's inherent to a no-API target,
  not a bug in the design.
- **Not headless, not a server.** It drives a visible window with a real profile, by design.
- **Unofficial.** This is not affiliated with Threads or Meta. Automating a platform may
  violate its Terms of Service. Use it at your own risk, keep it low-volume, and do not use it
  to harass people or to spam.
- **Personal data.** You are running it against your own account; the state file records
  handles you replied to. Treat `state.json` and the browser profile as private.

---

## License

MIT — see [LICENSE](LICENSE).
