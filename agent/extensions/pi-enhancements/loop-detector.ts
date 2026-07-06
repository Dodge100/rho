/**
 * LOOP DETECTOR — Detect tool call loops and inject circuit-breaker warnings.
 *
 * Maintains a sliding window of tool calls and detects three patterns:
 * 1. Exact repeat: same tool + same input hash 3+ times
 * 2. A-B oscillation: alternating pattern in last 6 actions
 * 3. Same-tool hammering: one tool called 5+ times in 8 actions with 3+ failures
 *
 * When detected, injects a warning message that makes the model change approach.
 *
 * Concepts borrowed from claynicholson/claude-code-re's loop detector.
 * Adapted for pi's extension model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

type ToolCallEntry = {
	toolName: string;
	inputHash: string;
	isError: boolean;
	timestamp: number;
	turnIndex: number;
};

type LoopWarning = {
	type: "exact_repeat" | "oscillation" | "hammering";
	toolName: string;
	message: string;
	turns: number;
};

// ── Module State ───────────────────────────────────────────────────────────

const window: ToolCallEntry[] = [];
let turnCounter = 0;
let injectedWarningCount = 0;
const MAX_WINDOW = 20;
const MAX_WARNINGS_PER_SESSION = 3;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Simple non-crypto hash for tool inputs.
 * Good enough for pattern matching, fast.
 */
function simpleHash(obj: unknown): string {
	const str = typeof obj === "string" ? obj : JSON.stringify(obj);
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash |= 0;
	}
	return Math.abs(hash).toString(36);
}

/**
 * Shorter labels for common tool names.
 */
function shortName(name: string): string {
	const map: Record<string, string> = {
		bash: "bash",
		read: "read",
		write: "write",
		edit: "edit",
		subagent: "agent",
		execute_plan: "plan",
		web_search: "search",
		fetch_content: "fetch",
		get_search_content: "get",
		workflow: "flow",
	};
	return map[name] || name;
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Detect exact repeat: same tool + same input hash appearing 3+ times.
 */
function detectExactRepeat(entries: ToolCallEntry[]): LoopWarning | null {
	const groups = new Map<string, ToolCallEntry[]>();
	for (const e of entries) {
		const key = `${e.toolName}:${e.inputHash}`;
		const group = groups.get(key) || [];
		group.push(e);
		groups.set(key, group);
	}

	for (const [key, group] of groups) {
		if (group.length >= 3) {
			const [toolName] = key.split(":");
			return {
				type: "exact_repeat",
				toolName,
				message: `You've called \`${toolName}\` with identical input ${group.length} times in the last ${entries.length} actions. Each call produced the same result. Try a different approach — the current one isn't converging.`,
				turns: group.length,
			};
		}
	}

	return null;
}

/**
 * Detect A-B oscillation: alternating pattern in last 6 actions.
 */
function detectOscillation(entries: ToolCallEntry[]): LoopWarning | null {
	const recent = entries.slice(-6);
	if (recent.length < 4) return null;

	// Check for alternating pattern: A, B, A, B or A, B, A, B, A
	const names = recent.map((e) => e.toolName);
	const unique = [...new Set(names)];

	if (unique.length === 2) {
		// Check if they strictly alternate
		let alternating = true;
		for (let i = 2; i < names.length; i++) {
			if (names[i] === names[i - 1]) {
				alternating = false;
				break;
			}
		}
		// First two must be different
		if (alternating && names[0] !== names[1]) {
			return {
				type: "oscillation",
				toolName: `${unique[0]}/${unique[1]}`,
				message: `You're oscillating between \`${unique[0]}\` and \`${unique[1]}\` without making progress. Try a fundamentally different approach.`,
				turns: names.length,
			};
		}
	}

	return null;
}

/**
 * Detect same-tool hammering: one tool called 5+ times in last 8 actions.
 */
function detectHammering(entries: ToolCallEntry[]): LoopWarning | null {
	const recent = entries.slice(-8);
	if (recent.length < 5) return null;

	const counts = new Map<string, { total: number; errors: number }>();
	for (const e of recent) {
		const c = counts.get(e.toolName) || { total: 0, errors: 0 };
		c.total++;
		if (e.isError) c.errors++;
		counts.set(e.toolName, c);
	}

	for (const [toolName, stats] of counts) {
		if (stats.total >= 5 && stats.errors >= 3) {
			return {
				type: "hammering",
				toolName,
				message: `You've called \`${toolName}\` ${stats.total} times (${stats.errors} errors) in the last ${recent.length} actions. ${stats.errors >= stats.total / 2 ? "Most calls are failing. " : ""}Switch strategies.`,
				turns: stats.total,
			};
		}
	}

	return null;
}

// ── Main API ───────────────────────────────────────────────────────────────

/**
 * Reset for new session.
 */
export function resetSession(): void {
	window.length = 0;
	turnCounter = 0;
	injectedWarningCount = 0;
}

/**
 * Record a tool call for loop detection.
 */
export function recordToolCall(
	toolName: string,
	input: unknown,
	isError: boolean,
): void {
	window.push({
		toolName: shortName(toolName),
		inputHash: simpleHash(input),
		isError,
		timestamp: Date.now(),
		turnIndex: turnCounter++,
	});

	// Keep window bounded
	if (window.length > MAX_WINDOW) {
		window.splice(0, window.length - MAX_WINDOW);
	}
}

/**
 * Check for loops and return a warning message if detected.
 * Returns null if no loop or warnings exhausted.
 */
export function detectLoop(): string | null {
	if (injectedWarningCount >= MAX_WARNINGS_PER_SESSION) return null;
	if (window.length < 4) return null;

	const warning =
		detectExactRepeat(window) || detectOscillation(window) || detectHammering(window);

	if (!warning) return null;

	injectedWarningCount++;

	return `⚠️ **Loop detected** (${warning.type}):\n${warning.message}\n\nStep back and reassess. What you're doing isn't working.`;
}

/**
 * Get a summary of tool call patterns for debugging.
 */
export function getWindowSummary(): string {
	if (window.length === 0) return "(empty)";
	const entries = window.map((e) => `${e.toolName}${e.isError ? "✗" : ""}`).join(" → ");
	return `[${window.length}] ${entries}`;
}
