# pi-zereight-router

[Jev](https://openrouter.ai/)-backed **virtual model** for [Pi](https://pi.dev): each user message is classified into plan, research, codebase explore, review, or implementation, then routed to a different backend model and effort level.

## Routing

| Phase (Jev) | Typical ask | Model | Effort |
| --- | --- | --- | --- |
| **planning** | Design, tradeoffs, planning without deep repo/web dive | `claude-bridge/claude-sonnet-5-5` | `medium` (fixed) |
| **research** | Docs, specs, web evidence | `claude-bridge/claude-sonnet-5-5` | `medium` (fixed) |
| **explore** | Find code in this repo, trace flows | `cursor/composer-2.5` | Your virtual-model setting |
| **review** | PR/diff/security review | `cursor/glm-5p3-flash` | `max` (fixed) |
| **implementation** | Edit files, build, fix | `cursor/composer-2.5` | Your virtual-model setting |

**Mid-turn handoff:** After the first successful `edit` or `write` in a **planning**, **research**, or **explore** turn, the rest of that turn uses **implementation** (Composer). **Review** stays on GLM until the next user message. Compaction and other `direct` routes go to Composer.

Status line example: `(router) plan-impl • medium → composer-2.5 • off` means the virtual model is `router/plan-impl`, you chose `medium`, and this request was routed to Composer (thinking shown as `off` when that model does not use your selected effort).

## Install

```bash
pi install git:github.com/zereight/pi-zereight-router
```

Or one session without adding to settings:

```bash
pi -e git:github.com/zereight/pi-zereight-router
```

After install: `/reload`, then `/model` → **Router: Sonnet (plan/research) · Composer (explore/impl) · GLM (review)** (`router/plan-impl`).

## Requirements

- **OpenRouter:** `OPENROUTER_API_KEY` (or OpenRouter login) so Jev (`openrouter/typesafe/jev-1.13`) can classify messages. If Jev is missing or fails, new messages default to **planning** (Sonnet).
- **Models in your Pi catalog:** `claude-bridge/claude-sonnet-5-5`, `cursor/composer-2.5`, `cursor/glm-5p3-flash` (e.g. via [pi-cursor-sdk](https://github.com/zereight/pi-cursor-sdk) and Claude bridge).

## Usage

```bash
pi --model router/plan-impl
```

## License

MIT
