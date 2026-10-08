/**
 * Multi-phase router — virtual models with per-task routing.
 *
 * Registers `router/cursor-router` (cursor provider) and `router/claude-router` (claude-bridge provider):
 *
 * - Planning: cursor/claude-sonnet-5-5@300k at medium effort.
 * - Research (evidence / web): cursor/grok-4.6 at high effort.
 * - Codebase explore: cursor/claude-haiku-5-5@300k at max effort.
 * - Jev "other" (misc): cursor/claude-haiku-5-5@300k at max effort.
 * - Review: cursor/grok-4.6 at low effort.
 * - Implementation: cursor/composer-2.5.
 *
 * claude-router only swaps Opus / Sonnet / Haiku and the effort level:
 * planning = Opus medium, research = Opus high, explore = Haiku max,
 * other = Haiku max, review = Opus low, implementation = Sonnet (user effort).
 *
 * Requires OPENROUTER_API_KEY (or an OpenRouter login) for Jev. Without Jev, new messages start in planning.
 * Usage: pi --model router/cursor-router | pi --model router/claude-router
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
import { logPhaseDecision, logRecoveryDecision, type PhaseFallback } from "./phase-decision-log.ts";

const CURSOR_PROVIDER = "cursor";
const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
const SONNET_MODEL = "claude-sonnet-5-5@300k";
const HAIKU_MODEL = "claude-haiku-5-5@300k";
const COMPOSER_MODEL = "composer-2.5";
const HAIKU_EFFORT: ThinkingLevel = "max";
const GROK_MODEL = "grok-4.6";
const CLAUDE_OPUS_MODEL = "claude-opus-5-5";
const CLAUDE_SONNET_MODEL = "claude-sonnet-5-5";
const CLAUDE_HAIKU_MODEL = "claude-haiku-5-5";
const JEV_PROVIDER = "openrouter";
const JEV_MODEL = "typesafe/jev-1.13";
/** Below this Jev confidence (0..1) the phase stays at the planning fallback. Read-only routing, so the floor is 0.5. */
const MIN_PHASE_CONFIDENCE = 0.5;
/**
 * Version of the phase decision contract: question text, option descriptions, state shape, confidence floor,
 * fallback and the regex boost. Bump it whenever one of them changes, so logged decisions stay comparable.
 */
const PHASE_CONTRACT_VERSION = "phase@3";
/** Escape hatch option: requests that fit none of the phases. Routed to the other phase and logged. */
const OTHER_CHOICE = "other";
/** Version of the recovery contract: question text, options, confidence floor, retry limit and defaults. */
const RECOVERY_CONTRACT_VERSION = "recover@1";
/** Below this confidence the recovery answer is ignored and the failed model is retried. */
const MIN_RECOVERY_CONFIDENCE = 0.5;
/** Retries on the failed model before the code forces a switch, whatever Jev says. */
const MAX_SAME_MODEL_RETRIES = 2;
const ERROR_TEXT_LIMIT = 2_000;

type RecoveryAction = "retry_same" | "switch_model";

/** Consecutive automatic retries since the last non-retry request. Kept in code so the loop stays bounded. */
let consecutiveRetries = 0;

const PHASE_ORDER: Phase[] = ["planning", "research", "explore", "review", "implementation", "other"];

/** `thinkingLevel` undefined means "use the effort the user selected". */
interface PhaseTarget {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

interface RouterProfile {
	id: string;
	name: string;
	targets: Record<Phase, PhaseTarget>;
}

const CURSOR_PROFILE: RouterProfile = {
	id: "cursor-router",
	name: "Cursor router: Sonnet (plan) · Grok (research) · Haiku max (explore/other) · Composer · Grok low (review)",
	targets: {
		planning: { provider: CURSOR_PROVIDER, id: SONNET_MODEL, thinkingLevel: "medium" },
		research: { provider: CURSOR_PROVIDER, id: GROK_MODEL, thinkingLevel: "high" },
		explore: { provider: CURSOR_PROVIDER, id: HAIKU_MODEL, thinkingLevel: HAIKU_EFFORT },
		other: { provider: CURSOR_PROVIDER, id: HAIKU_MODEL, thinkingLevel: HAIKU_EFFORT },
		review: { provider: CURSOR_PROVIDER, id: GROK_MODEL, thinkingLevel: "low" },
		implementation: { provider: CURSOR_PROVIDER, id: COMPOSER_MODEL },
	},
};

const CLAUDE_PROFILE: RouterProfile = {
	id: "claude-router",
	name: "Claude router: Opus (plan · research · review) · Haiku max (explore/other) · Sonnet (implement)",
	targets: {
		planning: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_OPUS_MODEL, thinkingLevel: "medium" },
		research: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_OPUS_MODEL, thinkingLevel: "high" },
		explore: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_HAIKU_MODEL, thinkingLevel: "max" },
		other: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_HAIKU_MODEL, thinkingLevel: "max" },
		review: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_OPUS_MODEL, thinkingLevel: "low" },
		implementation: { provider: CLAUDE_BRIDGE_PROVIDER, id: CLAUDE_SONNET_MODEL },
	},
};

const PROFILES: RouterProfile[] = [CURSOR_PROFILE, CLAUDE_PROFILE];

function routeTo(
	profile: RouterProfile,
	request: RoutePolicyRequest,
	ctx: ExtensionContext,
	phase: Phase,
	state?: RouterState,
	confidence?: number,
): ModelRoute<RouterState> {
	const target = profile.targets[phase];
	const model = ctx.modelRegistry.find(target.provider, target.id);
	if (!model) throw new Error(`Model ${target.provider}/${target.id} is not in the catalog`);
	noteRouteDispatch(ctx, phase, model.provider, model.id, confidence);
	const nextState: RouterState = state ?? { phase };
	return {
		model,
		thinkingLevel: target.thinkingLevel ?? request.thinkingLevel,
		state: { ...nextState, phase },
	};
}

function phaseFromProbabilities(probabilities: Record<string, number>): Phase {
	return PHASE_ORDER.reduce<Phase>((best, choice) => {
		const score = probabilities[choice] ?? 0;
		const bestScore = probabilities[best] ?? 0;
		return score > bestScore ? choice : best;
	}, "planning");
}

/** Phase for a new user message. Falls back to planning when Jev is unavailable, fails, or is unsure. */
async function classifyPhase(
	profile: RouterProfile,
	request: RoutePolicyRequest,
	ctx: ExtensionContext,
): Promise<{ phase: Phase; confidence?: number }> {
	const userText = lastUserText(request.messages);
	const jev = ctx.modelRegistry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	let phase: Phase = "planning";
	let confidence: number | undefined;
	let probabilities: Record<string, number> | undefined;
	let fallback: PhaseFallback = jev ? "none" : "no_jev";
	if (jev) {
		try {
			const result = await ctx.modelRegistry.classify(
				jev,
				{
					state: { message: userText.slice(0, 16_000) },
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
								[OTHER_CHOICE]:
									"None of the above: a short conceptual question, an opinion on a pasted article, small talk, or a git/shell chore that needs no code design",
							},
						},
					},
				},
				{ signal: request.signal },
			);
			const answer = result.stopReason === "stop" ? result.answers.phase : undefined;
			if (answer?.type === "choice") {
				confidence = answer.confidence;
				probabilities = answer.probabilities;
				if (answer.confidence < MIN_PHASE_CONFIDENCE) {
					fallback = "low_confidence";
				} else {
					const picked = phaseFromProbabilities(answer.probabilities);
					if (picked === OTHER_CHOICE) fallback = "other";
					phase = picked;
				}
			} else {
				fallback = "error";
			}
		} catch {
			fallback = "error";
		}
	}
	const finalPhase = boostPhaseForCodebaseSignals(phase, userText);
	logPhaseDecision({
		contract: PHASE_CONTRACT_VERSION,
		jevModel: `${JEV_PROVIDER}/${JEV_MODEL}`,
		profile: profile.id,
		fallback,
		confidence,
		probabilities,
		phaseBeforeBoost: phase,
		phase: finalPhase,
		message: userText,
	});
	return { phase: finalPhase, confidence };
}

/** Jev reads the failed request's error and picks between retrying the same model and switching. Code owns the retry limit. */
async function chooseRecovery(
	profile: RouterProfile,
	request: RoutePolicyRequest,
	ctx: ExtensionContext,
): Promise<RecoveryAction> {
	const errorText = (request.failed?.message.errorMessage ?? "").slice(0, ERROR_TEXT_LIMIT);
	let action: RecoveryAction = "retry_same";
	let fallback = "none";
	let confidence: number | undefined;
	let probabilities: Record<string, number> | undefined;
	const jev = ctx.modelRegistry.findOfType("classifier", JEV_PROVIDER, JEV_MODEL);
	if (consecutiveRetries > MAX_SAME_MODEL_RETRIES) {
		action = "switch_model";
		fallback = "retry_limit";
	} else if (!jev) {
		fallback = "no_jev";
	} else if (!errorText) {
		fallback = "no_error_text";
	} else {
		try {
			const result = await ctx.modelRegistry.classify(
				jev,
				{
					state: { error: errorText },
					questions: {
						recover: {
							type: "choice",
							instructions: "A model request failed with \`error\`. What should the next attempt do?",
							criteria: {
								retry_same:
									"A transient provider problem that a plain retry can fix: overloaded, rate limited, timeout, dropped connection, 5xx",
								switch_model:
									"A problem tied to this specific model that a retry will repeat: context window exceeded, unsupported input, model not found or not allowed",
								[OTHER_CHOICE]: "The error text does not say which of the two applies",
							},
						},
					},
				},
				{ signal: request.signal },
			);
			const answer = result.stopReason === "stop" ? result.answers.recover : undefined;
			if (answer?.type === "choice") {
				confidence = answer.confidence;
				probabilities = answer.probabilities;
				if (answer.confidence < MIN_RECOVERY_CONFIDENCE) fallback = "low_confidence";
				else if ((answer.probabilities.switch_model ?? 0) > (answer.probabilities.retry_same ?? 0)
					&& (answer.probabilities.switch_model ?? 0) > (answer.probabilities[OTHER_CHOICE] ?? 0)) action = "switch_model";
			} else {
				fallback = "error";
			}
		} catch {
			fallback = "error";
		}
	}
	logRecoveryDecision({
		contract: RECOVERY_CONTRACT_VERSION,
		jevModel: `${JEV_PROVIDER}/${JEV_MODEL}`,
		profile: profile.id,
		action,
		fallback,
		retryCount: consecutiveRetries,
		confidence,
		probabilities,
		failedModel: request.failed ? `${request.failed.model.provider}/${request.failed.model.id}` : undefined,
		errorMessage: errorText,
	});
	return action;
}

/** First phase whose target is a different physical model than the one that failed. */
function phaseForAlternateModel(profile: RouterProfile, request: RoutePolicyRequest): Phase | undefined {
	const failed = request.failed?.model;
	if (!failed) return undefined;
	return PHASE_ORDER.find((phase) => !isSameModel(profile.targets[phase], failed));
}

function isSameModel(target: PhaseTarget, failed: { provider: string; id: string }): boolean {
	return target.provider === failed.provider && target.id === failed.id;
}

/** Phase whose target is the model that just failed, so the retry stays on the same physical model. */
function phaseForFailedRetry(profile: RouterProfile, request: RoutePolicyRequest): Phase | undefined {
	const failed = request.failed?.model;
	if (!failed) return undefined;
	const currentPhase = request.state?.phase;
	if (currentPhase && isSameModel(profile.targets[currentPhase], failed)) return currentPhase;
	return PHASE_ORDER.find((phase) => isSameModel(profile.targets[phase], failed));
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
	for (const profile of PROFILES) registerProfile(pi, profile);
}

function registerProfile(pi: ExtensionAPI, profile: RouterProfile) {
	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: profile.id,
		name: profile.name,
		thinkingLevels: ["low", "medium", "high", "max"],
		async route(request, ctx) {
			if (request.reason !== "retry") consecutiveRetries = 0;
			if (request.reason === "direct") return routeTo(profile, request, ctx, "implementation");

			if (request.reason === "retry") {
				consecutiveRetries += 1;
				const action = await chooseRecovery(profile, request, ctx);
				const retryPhase =
					action === "switch_model"
						? (phaseForAlternateModel(profile, request) ?? phaseForFailedRetry(profile, request))
						: phaseForFailedRetry(profile, request);
				if (retryPhase) return routeTo(profile, request, ctx, retryPhase, request.state);
			}

			if (request.reason === "user" || !request.state) {
				const { phase, confidence } = await classifyPhase(profile, request, ctx);
				return routeTo(profile, request, ctx, phase, undefined, confidence);
			}

			const state = request.state;

			if (shouldHandOffToImplementation(state, request.messages)) {
				return routeTo(profile, request, ctx, "implementation", { phase: "implementation" });
			}

			return routeTo(profile, request, ctx, state.phase, state);
		},
	});
}
