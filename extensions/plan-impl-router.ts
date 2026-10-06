/**
 * Multi-phase router — virtual model with per-task routing.
 *
 * Registers `router/plan-impl`:
 *
 * - Planning: claude-bridge/claude-sonnet-5-5 at medium effort.
 * - Research (evidence / web): claude-bridge/claude-sonnet-5-5 at medium effort.
 * - Codebase explore: cursor/composer-2.5.
 * - Review: cursor/glm-5p3-flash at max effort.
 * - Implementation: cursor/composer-2.5.
 *
 * Each new user message is classified by Jev (via OpenRouter). Within a turn, the first successful
 * `edit` or `write` while in planning, research, or explore hands the rest of the turn to
 * Composer implementation. Review stays on GLM until the next user message. Direct requests (e.g.
 * compaction) go to Composer.
 *
 * Requires OPENROUTER_API_KEY (or an OpenRouter login) for Jev. Without Jev, new messages start in
 * planning.
 * Usage: pi --model router/plan-impl
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const SONNET_PROVIDER = "claude-bridge";
const SONNET_MODEL = "claude-sonnet-5-5";
const SONNET_THINKING: ThinkingLevel = "medium";
const REVIEW_PROVIDER = "cursor";
const REVIEW_MODEL = "glm-5p3-flash";
const REVIEW_THINKING: ThinkingLevel = "max";
const COMPOSER_PROVIDER = "cursor";
const COMPOSER_MODEL = "composer-2.5";
const JEV_PROVIDER = "openrouter";
const JEV_MODEL = "typesafe/jev-1.13";

/** Tools whose successful result means implementation has started. */
const EDIT_TOOLS = new Set(["edit", "write"]);

type Phase = "planning" | "research" | "explore" | "review" | "implementation";

/** Phases that hand off to implementation after the first successful edit in the same turn. */
const EDIT_HANDOFF_PHASES = new Set<Phase>(["planning", "research", "explore"]);

interface RouterState {
	phase: Phase;
}

type Request = ModelRouteRequest<RouterState>;

function routeTo(request: Request, ctx: ExtensionContext, phase: Phase): ModelRoute<RouterState> {
	const config = (() => {
		switch (phase) {
			case "planning":
			case "research":
				return { provider: SONNET_PROVIDER, id: SONNET_MODEL, thinkingLevel: SONNET_THINKING };
			case "explore":
			case "implementation":
				return { provider: COMPOSER_PROVIDER, id: COMPOSER_MODEL, thinkingLevel: request.thinkingLevel };
			case "review":
				return { provider: REVIEW_PROVIDER, id: REVIEW_MODEL, thinkingLevel: REVIEW_THINKING };
		}
	})();
	const model = ctx.modelRegistry.find(config.provider, config.id);
	if (!model) throw new Error(`Model ${config.provider}/${config.id} is not in the catalog`);
	return { model, thinkingLevel: config.thinkingLevel, state: { phase } };
}

function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Whether a tool call since the last user message edited a file successfully. */
function editedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some((message) => message.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError);
}

const PHASE_ORDER: Phase[] = ["planning", "research", "explore", "review", "implementation"];

function phaseFromProbabilities(probabilities: Record<string, number>): Phase {
	return PHASE_ORDER.reduce((best, phase) => {
		const score = probabilities[phase] ?? 0;
		const bestScore = probabilities[best] ?? 0;
		return score > bestScore ? phase : best;
	}, "planning" as Phase);
}

/** Phase for a new user message. Falls back to planning when Jev is unavailable or fails. */
async function classifyPhase(request: Request, ctx: ExtensionContext): Promise<Phase> {
	const jev = ctx.modelRegistry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	if (!jev) return "planning";
	try {
		const result = await ctx.modelRegistry.classify(
			jev,
			{
				state: { message: lastUserText(request.messages).slice(0, 16_000) },
				questions: {
					phase: {
						type: "choice",
						instructions: "What kind of software engineering work does `message` ask for?",
						criteria: {
							planning:
								"High-level design, tradeoffs, comparing approaches, or planning work without diving into the repo or the open web",
							research:
								"Answers that need concrete evidence, official documentation, specs, or web search — not mainly grepping the local codebase",
							explore:
								"Exploring this codebase: where code lives, how flows connect, tracing symbols, reading files, mapping architecture in-repo",
							review:
								"Code review, PR/diff review, security review, or critiquing existing code without implementing the fix",
							implementation:
								"Carrying out a clear, concrete change: writing code, editing files, or running a defined build/fix task",
						},
					},
				},
			},
			{ signal: request.signal },
		);
		const answer = result.stopReason === "stop" ? result.answers.phase : undefined;
		if (answer?.type !== "choice") return "planning";
		return phaseFromProbabilities(answer.probabilities);
	} catch {
		return "planning";
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "plan-impl",
		name: "Router: Sonnet (plan/research) · Composer (explore/impl) · GLM (review)",
		thinkingLevels: ["low", "medium", "high", "max"],
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, "implementation");
			if (request.reason === "user" || !request.state) return routeTo(request, ctx, await classifyPhase(request, ctx));
			if (EDIT_HANDOFF_PHASES.has(request.state.phase) && editedThisTurn(request.messages)) {
				return routeTo(request, ctx, "implementation");
			}
			return routeTo(request, ctx, request.state.phase);
		},
	});
}
