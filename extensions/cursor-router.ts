/**
 * Multi-phase router — virtual model with per-task routing (cursor provider only).
 *
 * Registers `router/cursor-router`:
 *
 * - Planning: cursor/claude-sonnet-5-5@300k at medium effort.
 * - Research (evidence / web): cursor/grok-4.6 at high effort.
 * - Codebase explore: cursor/composer-2.5.
 * - Review: cursor/grok-4.6 at low effort.
 * - Implementation: cursor/composer-2.5.
 *
 * Requires OPENROUTER_API_KEY (or an OpenRouter login) for Jev. Without Jev, new messages start in planning.
 * Usage: pi --model router/cursor-router
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import {
	formatRouterCacheReport,
	handleRouterCacheMessageEnd,
	noteRouteDispatch,
	resetRouterCacheTelemetry,
} from "./router-cache-telemetry.ts";
import {
	boostPhaseForCodebaseSignals,
	lastUserText,
	type Phase,
	type RoutePolicyRequest,
	type RouterState,
	shouldHandOffToImplementation,
} from "./route-policy.ts";

const CURSOR_PROVIDER = "cursor";
const SONNET_MODEL = "claude-sonnet-5-5@300k";
const SONNET_THINKING: ThinkingLevel = "medium";
const REVIEW_MODEL = "grok-4.6";
const REVIEW_THINKING: ThinkingLevel = "low";
const COMPOSER_MODEL = "composer-2.5";
const GROK_MODEL = "grok-4.6";
const GROK_THINKING: ThinkingLevel = "high";
const JEV_PROVIDER = "openrouter";
const JEV_MODEL = "typesafe/jev-1.13";
/** Below this Jev confidence (0..1) the phase stays at the planning fallback. Read-only routing, so the floor is 0.5. */
const MIN_PHASE_CONFIDENCE = 0.5;

const PHASE_ORDER: Phase[] = ["planning", "research", "explore", "review", "implementation"];
function routeTo(
	request: RoutePolicyRequest,
	ctx: ExtensionContext,
	phase: Phase,
	state?: RouterState,
	confidence?: number,
): ModelRoute<RouterState> {
	const config = (() => {
		switch (phase) {
			case "planning":
				return { provider: CURSOR_PROVIDER, id: SONNET_MODEL, thinkingLevel: SONNET_THINKING };
			case "research":
				return { provider: CURSOR_PROVIDER, id: GROK_MODEL, thinkingLevel: GROK_THINKING };
			case "explore":
			case "implementation":
				return { provider: CURSOR_PROVIDER, id: COMPOSER_MODEL, thinkingLevel: request.thinkingLevel };
			case "review":
				return { provider: CURSOR_PROVIDER, id: REVIEW_MODEL, thinkingLevel: REVIEW_THINKING };
		}
	})();
	const model = ctx.modelRegistry.find(config.provider, config.id);
	if (!model) throw new Error(`Model ${config.provider}/${config.id} is not in the catalog`);
	noteRouteDispatch(ctx, phase, model.provider, model.id, confidence);
	const nextState: RouterState = state ?? { phase };
	return { model, thinkingLevel: config.thinkingLevel, state: { ...nextState, phase } };
}

function phaseFromProbabilities(probabilities: Record<string, number>): Phase {
	return PHASE_ORDER.reduce<Phase>((best, phase) => {
		const score = probabilities[phase] ?? 0;
		const bestScore = probabilities[best] ?? 0;
		return score > bestScore ? phase : best;
	}, "planning");
}

/** Phase for a new user message. Falls back to planning when Jev is unavailable or fails. */
async function classifyPhase(
	request: RoutePolicyRequest,
	ctx: ExtensionContext,
): Promise<{ phase: Phase; confidence?: number }> {
	const jev = ctx.modelRegistry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	let phase: Phase = "planning";
	let confidence: number | undefined;
	if (jev) {
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
			if (answer?.type === "choice") confidence = answer.confidence;
			if (answer?.type === "choice" && answer.confidence >= MIN_PHASE_CONFIDENCE) {
				phase = phaseFromProbabilities(answer.probabilities);
			}
		} catch {
			phase = "planning";
		}
	}
	const userText = lastUserText(request.messages);
	return { phase: boostPhaseForCodebaseSignals(phase, userText), confidence };
}

function phaseForFailedRetry(request: RoutePolicyRequest): Phase | undefined {
	const failed = request.failed?.model;
	if (!failed || failed.provider !== CURSOR_PROVIDER) return undefined;
	if (failed.id === COMPOSER_MODEL) return "implementation";
	if (failed.id === REVIEW_MODEL) return "review";
	if (failed.id === SONNET_MODEL) return request.state?.phase ?? "planning";
	if (failed.id === GROK_MODEL) return request.state?.phase ?? "research";
	return undefined;
}

/** Marker that apply-pi-routed-model-footer-patch.mjs leaves in Pi's bundled session code. */
const FOOTER_PATCH_MARKER = "_dispatchedRoute";

function isFooterPatched(): boolean | undefined {
	try {
		const chunksDir = join(dirname(realpathSync(process.argv[1] ?? "")), "chunks");
		const sources = readdirSync(chunksDir)
			.filter((name) => name.endsWith(".js"))
			.map((name) => readFileSync(join(chunksDir, name), "utf8"))
			.filter((source) => source.includes("get routedModel"));
		if (sources.length === 0) return undefined;
		return sources.some((source) => source.includes(FOOTER_PATCH_MARKER));
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		resetRouterCacheTelemetry();
		if (!ctx.hasUI || isFooterPatched() !== false) return;
		ctx.ui.notify(
			"pi-zereight-router: Pi footer patch is missing (likely reverted by a Pi update). " +
				"Run: node ~/Documents/pi-zereight-router/scripts/apply-pi-routed-model-footer-patch.mjs",
			"warning",
		);
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		handleRouterCacheMessageEnd(event.message, ctx);
	});
	pi.registerCommand("router-cache-stats", {
		description: "Virtual router: per-backend prompt cache hit rates",
		handler: async (_args, ctx) => {
			const report = formatRouterCacheReport().join("\n");
			await ctx.ui.notify(report, "info");
			console.log(report);
		},
	});
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "cursor-router",
		name: "Cursor router: Sonnet (plan) · Grok (research) · Composer · Grok low (review)",
		thinkingLevels: ["low", "medium", "high", "max"],
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, "implementation");

			if (request.reason === "retry") {
				const retryPhase = phaseForFailedRetry(request);
				if (retryPhase) return routeTo(request, ctx, retryPhase, request.state);
			}

			if (request.reason === "user" || !request.state) {
				const { phase, confidence } = await classifyPhase(request, ctx);
				return routeTo(request, ctx, phase, undefined, confidence);
			}

			const state = request.state;

			if (shouldHandOffToImplementation(state, request.messages)) {
				return routeTo(request, ctx, "implementation", { phase: "implementation" });
			}

			return routeTo(request, ctx, state.phase, state);
		},
	});
}
