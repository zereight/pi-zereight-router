import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Why the phase is not simply Jev's argmax. "none" means Jev's own answer was used. */
export type PhaseFallback = "none" | "no_jev" | "error" | "low_confidence" | "other";

export interface PhaseDecisionRecord {
	contract: string;
	jevModel: string;
	profile: string;
	fallback: PhaseFallback;
	confidence?: number;
	probabilities?: Record<string, number>;
	phaseBeforeBoost: string;
	phase: string;
	message: string;
}

/** Lives under the user's Pi dir, never inside this repo, so the log cannot be committed by accident. */
const LOG_DIR = join(homedir(), ".pi", "agent", "router-logs");
const LOG_FILE = join(LOG_DIR, "phase-decisions.jsonl");
const MESSAGE_PREVIEW_CHARS = 160;

/** Appends one JSON line per phase decision. Logging must never break routing, so failures are swallowed. */
export function logPhaseDecision(record: PhaseDecisionRecord): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
		const { message, ...rest } = record;
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			...rest,
			messageChars: message.length,
			messagePreview: message.slice(0, MESSAGE_PREVIEW_CHARS),
		});
		appendFileSync(LOG_FILE, line + "\n", { mode: 0o600 });
		chmodSync(LOG_FILE, 0o600);
	} catch {
		// Best-effort telemetry.
	}
}
