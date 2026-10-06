/**
 * Measures prompt-cache hit rate across virtual-model route switches.
 * Complements Pi core "Cache miss after model switch" notices (settings → cache miss).
 */
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelUsageTotals {
	cacheRead: number;
	input: number;
	turns: number;
}

interface RouteTransitionPending {
	fromKey: string;
	toKey: string;
	fromPhase: string;
	toPhase: string;
	previousTurnHitRate: number | null;
}

interface SessionTotals {
	cacheRead: number;
	input: number;
	turns: number;
}

let lastDispatchedKey: string | null = null;
let lastDispatchedPhase: string | null = null;
let lastTurnHitRateByModel = new Map<string, number>();
let pendingTransition: RouteTransitionPending | null = null;
let sessionTotals: SessionTotals = { cacheRead: 0, input: 0, turns: 0 };
let perModelTotals = new Map<string, ModelUsageTotals>();
let transitionCount = 0;

export function modelRouteKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function calcTurnHitRate(usage: Usage): number | null {
	const cacheRead = usage.cacheRead;
	const input = usage.input;
	const denom = cacheRead + input;
	if (denom <= 0) return null;
	return (cacheRead / denom) * 100;
}

function calcAggregateHitRate(totals: { cacheRead: number; input: number }): number | null {
	const denom = totals.cacheRead + totals.input;
	if (denom <= 0) return null;
	return (totals.cacheRead / denom) * 100;
}

function formatHitRate(rate: number | null): string {
	if (rate === null) return "n/a";
	return `${rate.toFixed(1)}%`;
}

function shortKey(key: string): string {
	const slash = key.indexOf("/");
	return slash >= 0 ? key.slice(slash + 1) : key;
}

function addUsage(totals: ModelUsageTotals, usage: Usage): ModelUsageTotals {
	return {
		cacheRead: totals.cacheRead + usage.cacheRead,
		input: totals.input + usage.input,
		turns: totals.turns + 1,
	};
}

export function resetRouterCacheTelemetry(): void {
	lastDispatchedKey = null;
	lastDispatchedPhase = null;
	lastTurnHitRateByModel = new Map();
	pendingTransition = null;
	sessionTotals = { cacheRead: 0, input: 0, turns: 0 };
	perModelTotals = new Map();
	transitionCount = 0;
}

/** Call when `route()` picks a physical model (before the provider request). */
export function noteRouteDispatch(
	ctx: ExtensionContext,
	phase: string,
	provider: string,
	modelId: string,
): void {
	const toKey = modelRouteKey(provider, modelId);
	const previousTurnHitRate =
		lastDispatchedKey !== null ? (lastTurnHitRateByModel.get(lastDispatchedKey) ?? null) : null;

	if (lastDispatchedKey !== null && lastDispatchedKey !== toKey) {
		pendingTransition = {
			fromKey: lastDispatchedKey,
			toKey,
			fromPhase: lastDispatchedPhase ?? "?",
			toPhase: phase,
			previousTurnHitRate,
		};
		transitionCount += 1;
		if (ctx.hasUI) {
			const prevHint =
				previousTurnHitRate !== null
					? `직전 ${shortKey(lastDispatchedKey)} 마지막 턴 hit ${formatHitRate(previousTurnHitRate)}`
					: "직전 턴에 캐시 usage 없음";
			ctx.ui.notify(
				`[router-cache] ${shortKey(lastDispatchedKey)} → ${shortKey(toKey)} (${phase}) · ${prevHint} · provider/모델이 다르면 prompt cache는 cold start`,
				"info",
			);
		}
	} else {
		pendingTransition = null;
	}

	lastDispatchedKey = toKey;
	lastDispatchedPhase = phase;
}

/** Call from `message_end` for assistant messages. */
export function handleRouterCacheMessageEnd(message: AssistantMessage, ctx: ExtensionContext): void {
	const usage = message.usage;
	const key = modelRouteKey(message.provider, message.model);
	const turnRate = calcTurnHitRate(usage);

	sessionTotals = {
		cacheRead: sessionTotals.cacheRead + usage.cacheRead,
		input: sessionTotals.input + usage.input,
		turns: sessionTotals.turns + 1,
	};

	const modelStats = perModelTotals.get(key) ?? { cacheRead: 0, input: 0, turns: 0 };
	perModelTotals.set(key, addUsage(modelStats, usage));

	if (turnRate !== null) {
		lastTurnHitRateByModel.set(key, turnRate);
	}

	const sessionRate = calcAggregateHitRate(sessionTotals);
	if (ctx.hasUI && sessionRate !== null) {
		const switchSuffix = transitionCount > 0 ? ` · ${transitionCount} switch` : "";
		ctx.ui.setStatus("router-cache", `router-cache ${sessionRate.toFixed(1)}%${switchSuffix}`);
	}

	if (!pendingTransition || pendingTransition.toKey !== key) return;

	const prev = pendingTransition.previousTurnHitRate;
	const delta =
		prev !== null && turnRate !== null ? ` · Δ ${(turnRate - prev).toFixed(1)}pp` : "";
	const level =
		prev !== null && turnRate !== null && turnRate < prev - 5 ? "warning" : "info";

	if (ctx.hasUI) {
		ctx.ui.notify(
			`[router-cache] 전환 후 1턴 ${shortKey(key)}: hit ${formatHitRate(turnRate)} · 직전 ${formatHitRate(prev)}${delta}`,
			level,
		);
	}
	pendingTransition = null;
}

export function formatRouterCacheReport(): string[] {
	const lines: string[] = [];
	const sessionRate = calcAggregateHitRate(sessionTotals);
	lines.push(
		`Session: ${formatHitRate(sessionRate)} over ${sessionTotals.turns} assistant turn(s), ${transitionCount} route switch(es).`,
	);
	if (perModelTotals.size === 0) {
		lines.push("No per-model usage yet.");
		return lines;
	}
	const sorted = [...perModelTotals.entries()].sort((a, b) => b[1].turns - a[1].turns);
	for (const [key, totals] of sorted) {
		const rate = calcAggregateHitRate(totals);
		const lastTurn = lastTurnHitRateByModel.get(key);
		lines.push(
			`  ${key}: agg ${formatHitRate(rate)} · last turn ${formatHitRate(lastTurn ?? null)} · ${totals.turns} turn(s)`,
		);
	}
	return lines;
}
