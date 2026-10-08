/**
 * Routing policy for pi-zereight-router (cursor-only backends).
 */
import type { Message } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";

export type Phase = "planning" | "research" | "explore" | "review" | "implementation" | "other";

export interface RouterState {
	phase: Phase;
}

/** Tools whose successful result means implementation has started (Pi + Cursor aliases). */
const MUTATION_TOOL_NAMES = new Set([
	"edit",
	"write",
	"strreplace",
	"delete",
	"apply_patch",
	"applypatch",
	"edit_file",
	"write_file",
]);

const EDIT_HANDOFF_PHASES = new Set<Phase>(["planning", "research", "explore", "other"]);

const CODEBASE_EXPLORE_PATTERN =
	/\b(codebase|repo(sitory)?|monorepo|grep|tgrep|trace|symbol|refactor|hold\s*code|qr[\s-]?tab|navigat|@features\/|packages\/|\.tsx\b|\.ts\b|git\s+diff|diff\b|implement|수정|추적|코드베이스|리포|파일)\b/i;

export function lastUserText(messages: readonly Message[]): string {
	const content = messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

export function normalizeMutationToolName(toolName: string): string {
	return toolName.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

export function isMutationToolResult(toolName: string): boolean {
	return MUTATION_TOOL_NAMES.has(normalizeMutationToolName(toolName));
}

/** Whether a tool call since the last user message mutated files successfully. */
export function mutatedThisTurn(messages: readonly Message[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return messages
		.slice(lastUser + 1)
		.some(
			(message) =>
				message.role === "toolResult" && isMutationToolResult(message.toolName) && !message.isError,
		);
}

export function shouldHandOffToImplementation(state: RouterState, messages: readonly Message[]): boolean {
	return EDIT_HANDOFF_PHASES.has(state.phase) && mutatedThisTurn(messages);
}

/** Boost planning/research to explore when the message is clearly repo work. */
export function boostPhaseForCodebaseSignals(phase: Phase, userText: string): Phase {
	if (phase !== "planning" && phase !== "research") return phase;
	if (!CODEBASE_EXPLORE_PATTERN.test(userText)) return phase;
	return "explore";
}

export type RoutePolicyRequest = ModelRouteRequest<RouterState>;
