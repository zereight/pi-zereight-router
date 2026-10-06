#!/usr/bin/env node
/**
 * Pi 1.0.x footer shows virtual-model dispatch only after the assistant message
 * completes (routedModel reads findLatestResponse). This patches Pi so the footer
 * updates as soon as prepareRequest picks a physical model.
 *
 * Re-run after `npm update` / reinstall of @earendil-works/pi-coding-agent.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const piRoot = dirname(require.resolve("@earendil-works/pi-coding-agent/package.json"));

const agentSessionPath = join(piRoot, "dist/core/agent-session.js");
const interactivePath = join(piRoot, "dist/modes/interactive/interactive-mode.js");
const bundlePath = join(piRoot, "dist/bundle/chunks/chunk-H33F2TZD.js");

function patchAgentSession(source) {
	if (source.includes("_dispatchedRoute")) {
		return { source, changed: false };
	}
	let next = source;
	next = next.replace(
		"    _isAgentRunActive = false;\n    _agentRunAbortRequested = false;",
		"    _isAgentRunActive = false;\n    _agentRunAbortRequested = false;\n    /** Physical model chosen for the in-flight request (footer updates before the assistant message completes). */\n    _dispatchedRoute;",
	);
	next = next.replace(
		"            return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };",
		`            this._dispatchedRoute = { model: route.model, thinkingLevel: route.thinkingLevel };
            this._emit({
                type: "routed_model_changed",
                model: route.model,
                thinkingLevel: route.thinkingLevel,
            });
            return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };`,
	);
	next = next.replace(
		"    /** Under a virtual selection, the physical model and thinking level of the latest successful response. */\n    get routedModel() {\n        if (!this.model || !isVirtualModel(this.model))\n            return undefined;\n        const latest = findLatestResponse(this.agent.state.messages);",
		"    /** Under a virtual selection, the dispatched or latest successful physical model and thinking level. */\n    get routedModel() {\n        if (!this.model || !isVirtualModel(this.model))\n            return undefined;\n        if (this._dispatchedRoute)\n            return this._dispatchedRoute;\n        const latest = findLatestResponse(this.agent.state.messages);",
	);
	return { source: next, changed: next !== source };
}

function patchInteractive(source) {
	if (source.includes('case "routed_model_changed"')) {
		return { source, changed: false };
	}
	const needle = `            case "session_info_changed":
                this.updateTerminalTitle();
                this.footer.invalidate();
                this.ui.requestRender();
                break;`;
	const insert = `            case "routed_model_changed":
                this.footer.invalidate();
                this.ui.requestRender();
                break;
            case "session_info_changed":
                this.updateTerminalTitle();
                this.footer.invalidate();
                this.ui.requestRender();
                break;`;
	if (!source.includes(needle)) {
		throw new Error("interactive-mode.js: session_info_changed block not found (Pi version mismatch?)");
	}
	return { source: source.replace(needle, insert), changed: true };
}

function patchBundle(source) {
	if (source.includes("_dispatchedRoute")) {
		return { source, changed: false };
	}
	const replacements = [
		[
			"_isAgentRunActive=!1;_agentRunAbortRequested=!1;",
			"_isAgentRunActive=!1;_agentRunAbortRequested=!1;_dispatchedRoute;",
		],
		[
			")),{...previous,context,model:route.model,thinkingLevel:route.thinkingLevel}}}async _dispatchTurnEndBoun",
			'")),this._dispatchedRoute={model:route.model,thinkingLevel:route.thinkingLevel},this._emit({type:"routed_model_changed",model:route.model,thinkingLevel:route.thinkingLevel}),{...previous,context,model:route.model,thinkingLevel:route.thinkingLevel}}}async _dispatchTurnEndBoun',
		],
		[
			"get routedModel(){if(!this.model||!isVirtualModel(this.model))return;let latest=findLatestResponse",
			"get routedModel(){if(!this.model||!isVirtualModel(this.model))return;if(this._dispatchedRoute)return this._dispatchedRoute;let latest=findLatestResponse",
		],
		[
			'break;case"session_info_changed":this.updateTerminalTitle(),this.footer.invalidate(),this.ui.requestRender();break;case"thinki',
			'break;case"routed_model_changed":this.footer.invalidate(),this.ui.requestRender();break;case"session_info_changed":this.updateTerminalTitle(),this.footer.invalidate(),this.ui.requestRender();break;case"thinki',
		],
	];
	let next = source;
	for (const [from, to] of replacements) {
		if (!next.includes(from)) {
			throw new Error(`bundle chunk: anchor not found: ${from.slice(0, 60)}…`);
		}
		next = next.replace(from, to);
	}
	return { source: next, changed: next !== source };
}

function apply(path, patchFn) {
	const original = readFileSync(path, "utf8");
	const { source, changed } = patchFn(original);
	if (changed) {
		writeFileSync(path, source);
		console.log(`patched ${path}`);
	} else {
		console.log(`already patched ${path}`);
	}
}

apply(agentSessionPath, patchAgentSession);
apply(interactivePath, patchInteractive);
apply(bundlePath, patchBundle);
console.log("done — restart Pi or /reload");
