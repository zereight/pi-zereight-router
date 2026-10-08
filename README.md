# pi-zereight-router

[Jev](https://openrouter.ai/)-backed **virtual model** for [Pi](https://pi.dev): each user message is classified into plan, research, codebase explore, review, or implementation, then routed to a different **Cursor** backend model and effort level.

## Routing

| Phase (Jev) | Typical ask | Model | Effort |
| --- | --- | --- | --- |
| **planning** | Design, tradeoffs, planning without deep repo/web dive | `cursor/claude-sonnet-5-5@300k` | `medium` (fixed) |
| **research** | Docs, specs, web evidence | `cursor/grok-4.6` | `high` (fixed) |
| **explore** | Find code in this repo, trace flows | `cursor/claude-haiku-5-5@300k` | `max` (fixed) |
| **other** | Misc / none-of-the-above (Jev) | `cursor/claude-haiku-5-5@300k` | `max` (fixed) |
| **review** | PR/diff/security review | `cursor/grok-4.6` | `low` (fixed) |
| **implementation** | Edit files, build, fix | `cursor/composer-2.5` | Your virtual-model setting |

All backends use the **cursor** provider (pi-cursor-sdk). There is no claude-bridge hop.

**Mid-turn handoff:** After the first successful file mutation (`edit` / `write` / Cursor `StrReplace`, etc.) in a **planning**, **research**, **explore**, or **other** turn, the rest of that turn uses **implementation** (Composer). **Review** stays on Grok 4.6 low until the next user message. Compaction and other `direct` routes go to Composer.

**Retry:** Failed requests retry on the **same physical model** (no accidental review ↔ composer switch on `reason: retry`).

**pi-cursor-sdk:** After router model switches, force a full Cursor bootstrap when `modelSelection` changes (avoids incremental prompts with the wrong tool manifest). Re-apply after SDK updates:

```bash
node ~/Documents/pi-zereight-router/scripts/apply-pi-cursor-model-bootstrap-patch.mjs
```

Status line example: `(router) cursor-router • medium → composer-2.5 • off` means the virtual model is `router/cursor-router`, you chose `medium`, and this request was routed to Composer (thinking shown as `off` when that model does not use your selected effort).

**Footer timing (Pi ≤ 1.0.4):** Stock Pi only updates the `→ model` suffix after the assistant message finishes. For an immediate update when routing completes (right after Jev + `route()`), run once:

```bash
node scripts/apply-pi-routed-model-footer-patch.mjs
```

Re-run after upgrading `@earendil-works/pi-coding-agent`. Long-term this belongs in Pi core upstream.

## Cache measurement (routing)

Pi core can show **Cache miss after model switch** in the transcript when cache-miss notices are enabled in settings. This package adds router-specific telemetry:

- **On route switch:** TUI `notify` with the previous backend’s last-turn hit rate and a cold-start reminder (provider/model caches do not transfer).
- **After the first assistant message on the new backend:** `notify` with this turn’s hit %, the previous backend’s last turn, and Δ in percentage points.
- **Status line:** `router-cache 54.2% · 2 switch` (session aggregate over `cacheRead / (cacheRead + input)`).
- **Command:** `/router-cache-stats` — per-backend aggregate and last-turn hit rates.

Hit rate uses the same per-turn formula as common Pi telemetry (`cacheRead / (cacheRead + input)`). Providers that never report cache fields stay at `n/a`.

## Install

```bash
pi install git:github.com/zereight/pi-zereight-router
```

Or one session without adding to settings:

```bash
pi -e git:github.com/zereight/pi-zereight-router
```

After install: `/reload`, then `/model` → **Cursor router: Sonnet (plan) · Grok (research) · Haiku max (explore/other) · Composer · Grok low (review)** (`router/cursor-router`).

## Requirements

- **OpenRouter:** `OPENROUTER_API_KEY` (or OpenRouter login) so Jev (`openrouter/typesafe/jev-1.13`) can classify messages. If Jev is missing or fails, new messages default to **planning** (Cursor Sonnet 5.5 @300k).
- **Models in your Pi catalog:** `cursor/claude-sonnet-5-5@300k`, `cursor/claude-haiku-5-5@300k`, `cursor/grok-4.6`, `cursor/composer-2.5` (via [pi-cursor-sdk](https://github.com/zereight/pi-cursor-sdk)).

## Usage

```bash
pi --model router/cursor-router
# or Claude only (claude-bridge): Opus plan/research/review, Sonnet explore/implement
pi --model router/claude-router
```

## License

MIT

## Phase decision log (local only)

Every new-message classification appends one JSON line to `~/.pi/agent/router-logs/phase-decisions.jsonl` (dir `0700`, file `0600`). The file lives outside this repo, and `router-logs/` and `*.jsonl` are git-ignored. Each line records the contract version (`phase@N`), Jev model, confidence, full probability distribution, fallback reason (`none`, `no_jev`, `error`, `low_confidence`, `other`), the phase before and after the regex boost, and the first 160 characters of the message. Bump `PHASE_CONTRACT_VERSION` in `extensions/cursor-router.ts` whenever the question, options, confidence floor, fallback or boost changes.

## Recovery path (automatic retries)

On a `retry` request the router asks Jev (`recover@1`) whether the failed error text means `retry_same` (overloaded, rate limit, timeout) or `switch_model` (context overflow, unsupported input). Low confidence, `other`, a missing Jev or an error all mean `retry_same`. After `MAX_SAME_MODEL_RETRIES` (2) consecutive retries the code forces a switch to the first phase target on a different model, whatever Jev says. A route must return a model, so "stop and ask" is not offered. Decisions are logged to `~/.pi/agent/router-logs/recovery-decisions.jsonl` (same permissions and git-ignore rules as the phase log).
