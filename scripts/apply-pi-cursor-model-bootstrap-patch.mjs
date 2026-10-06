#!/usr/bin/env node
/**
 * Re-apply pi-cursor-sdk dist patches for model-selection bootstrap (virtual router glm ↔ composer).
 * Idempotent. Re-run after `npm update` of pi-cursor-sdk.
 *
 * Source of truth for logic: zereight/pi-zereight-router (same patches as manual dist edits).
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolvePiCursorSdkRoot() {
	const candidates = [
		process.env.PI_CURSOR_SDK_ROOT,
		join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/pi-cursor-sdk"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return dirname(require.resolve("pi-cursor-sdk/package.json", { paths: [candidate] }));
		} catch {
			try {
				const pkg = join(candidate, "package.json");
				require(pkg);
				return candidate;
			} catch {
				// try next
			}
		}
	}
	throw new Error("pi-cursor-sdk not found. Set PI_CURSOR_SDK_ROOT or install via pi packages.");
}

const root = resolvePiCursorSdkRoot();

const MARKER = "model_selection_changed";

function patch(path, apply) {
	const full = join(root, path);
	let text = readFileSync(full, "utf8");
	if (text.includes(MARKER)) return false;
	text = apply(text);
	writeFileSync(full, text);
	return true;
}

let changed = false;

changed =
	patch("dist/cursor-session-send-policy.js", (t) =>
		t.replace(
			"export function planCursorSessionSend(sendState, context) {\n    if (!sendState.bootstrapped)",
			`export function planCursorSessionSend(sendState, context, modelSelectionKey) {
    if (modelSelectionKey !== undefined &&
        sendState.lastModelSelectionKey !== undefined &&
        sendState.lastModelSelectionKey !== modelSelectionKey) {
        return { mode: "bootstrap", resetAgent: true, reason: "${MARKER}" };
    }
    if (!sendState.bootstrapped)`,
		),
	) || changed;

changed =
	patch("dist/cursor-session-agent.js", (t) => {
		let next = t.replace(
			"return { bootstrapped: false, contextFingerprint: \"\", incrementalSendCount: 0 };",
			"return { bootstrapped: false, contextFingerprint: \"\", incrementalSendCount: 0, lastModelSelectionKey: undefined };",
		);
		next = next.replace(
			"function commitSessionAgentSendForLease(scopeKey, poolKey, instanceId, context, bootstrapped) {",
			"function commitSessionAgentSendForLease(scopeKey, poolKey, instanceId, context, bootstrapped, modelSelectionKey) {",
		);
		next = next.replace(
			"    entry.sendState.contextFingerprint = computeCursorContextFingerprint(context);\n    if (bootstrapped) {",
			"    entry.sendState.contextFingerprint = computeCursorContextFingerprint(context);\n    if (modelSelectionKey !== undefined) {\n        entry.sendState.lastModelSelectionKey = modelSelectionKey;\n    }\n    if (bootstrapped) {",
		);
		next = next.replace(
			"commitSessionAgentSendForLease(scopeKey, entry.poolKey, entry.instanceId, context, bootstrapped);",
			"commitSessionAgentSendForLease(scopeKey, entry.poolKey, entry.instanceId, context, bootstrapped, modelSelectionKey);",
		);
		next = next.replace(
			"commitSend: (context, bootstrapped) => {",
			"commitSend: (context, bootstrapped, modelSelectionKey) => {",
		);
		return next;
	}) || changed;

changed =
	patch("dist/cursor-provider-turn-prepare.js", (t) => {
		let next = t.replace(
			"function buildLocalCursorProviderTurnLifecycle(lease, scopeKey) {",
			"function buildLocalCursorProviderTurnLifecycle(lease, scopeKey, modelSelectionKey) {",
		);
		next = next.replace(
			"commitSend: (context, bootstrapped) => lease.commitSend(context, bootstrapped),",
			"commitSend: (context, bootstrapped) => lease.commitSend(context, bootstrapped, modelSelectionKey),",
		);
		next = next.replace(
			"        let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);",
			"        const modelSelectionKey = JSON.stringify(selection);\n        let sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context, modelSelectionKey);",
		);
		next = next.replace(
			"            sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context);",
			"            sendPlan = planCursorSessionSend(sessionAgentLease.sendState, context, modelSelectionKey);",
		);
		next = next.replace(
			"buildLocalCursorProviderTurnLifecycle(sessionAgentLease, sessionAgentScopeKey),",
			"buildLocalCursorProviderTurnLifecycle(sessionAgentLease, sessionAgentScopeKey, modelSelectionKey),",
		);
		return next;
	}) || changed;

const sendPolicy = readFileSync(join(root, "dist/cursor-session-send-policy.js"), "utf8");
if (!sendPolicy.includes(MARKER)) {
	console.error("pi-cursor-sdk: patch incomplete — check dist files manually.");
	process.exit(1);
}
console.log(changed ? "pi-cursor-sdk: model bootstrap patch applied." : "pi-cursor-sdk: already patched.");
