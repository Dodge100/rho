/**
 * IMMUNE MEMORY — Cross-project error antibodies.
 *
 * Learns reusable error patterns across ALL projects. When the same kind of
 * error keeps happening in different projects, it builds confidence that the
 * pattern is worth injecting. Only injects when 60%+ reliable.
 *
 * Builds on scar-tissue's normalization infrastructure.
 * Stores in a separate file (immune-memory.json) because it's project-agnostic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

export type Antibody = {
	pattern: string; // Normalized error pattern (e.g., "<TOOL> → <ERR>: <PATH> not found")
	errorClass: string; // Normalized error class
	toolName: string; // Which tool
	encounters: number; // Total times this error was seen
	successes: number; // Times a resolution was later recorded
	lastSeen: number; // Timestamp
	created: number; // Timestamp
};

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ANTIBODIES = 100;
const MIN_ENCOUNTERS = 2; // Need at least 2 encounters
const MIN_CONFIDENCE = 0.6; // 60%+ success rate to inject
const ANTIBODY_FILE = "immune-memory.json";

// ── Paths ──────────────────────────────────────────────────────────────────

function getImmunePath(): string {
	const agentDir = getAgentDir();
	const scarsDir = path.join(agentDir, "scars");
	if (!fs.existsSync(scarsDir)) {
		fs.mkdirSync(scarsDir, { recursive: true });
	}
	return path.join(scarsDir, ANTIBODY_FILE);
}

function loadAntibodies(): Antibody[] {
	const filePath = getImmunePath();
	if (!fs.existsSync(filePath)) return [];
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return [];
	}
}

function saveAntibodies(antibodies: Antibody[]): void {
	fs.writeFileSync(getImmunePath(), JSON.stringify(antibodies, null, 2));
}

// ── Confidence ─────────────────────────────────────────────────────────────

function confidence(ab: Antibody): number {
	if (ab.encounters === 0) return 0;
	return ab.successes / ab.encounters;
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Record an error encounter.
 * Call from recordScar (alongside normal scar recording).
 * Creates or updates an antibody for this error pattern.
 */
export function recordErrorEncounter(errorClass: string, toolName: string): void {
	try {
		const antibodies = loadAntibodies();
		const pattern = `${toolName}:${errorClass}`;

		const existing = antibodies.find((a) => a.pattern === pattern);
		if (existing) {
			existing.encounters += 1;
			existing.lastSeen = Date.now();
		} else {
			antibodies.push({
				pattern,
				errorClass,
				toolName,
				encounters: 1,
				successes: 0,
				lastSeen: Date.now(),
				created: Date.now(),
			});
		}

		saveAntibodies(antibodies.slice(-MAX_ANTIBODIES));
	} catch {
		// Never crash
	}
}

/**
 * Record a successful resolution (called after tools that succeed after failures).
 * Increments the success counter for matching antibodies.
 */
export function recordImmuneResolution(errorClass: string, toolName: string): void {
	try {
		const antibodies = loadAntibodies();
		const pattern = `${toolName}:${errorClass}`;
		const existing = antibodies.find((a) => a.pattern === pattern);
		if (existing) {
			existing.successes += 1;
			saveAntibodies(antibodies.slice(-MAX_ANTIBODIES));
		}
	} catch {
		// Never crash
	}
}

/**
 * Get high-confidence antibodies, formatted as context text.
 * Only returns patterns with 60%+ reliability and 2+ encounters.
 */
export function getImmuneContext(projectId: string): string {
	try {
		const antibodies = loadAntibodies();
		if (antibodies.length === 0) return "";

		const relevant = antibodies
			.filter((a) => a.encounters >= MIN_ENCOUNTERS && confidence(a) >= MIN_CONFIDENCE)
			.sort((a, b) => b.encounters - a.encounters)
			.slice(0, 5);

		if (relevant.length === 0) return "";

		// Dedup against project-specific scars so we don't repeat
		// (immune memory is injected alongside scars; avoid overlap)
		const lines = relevant.map(
			(a) =>
				`- [${a.toolName}] ${a.errorClass} — seen ${a.encounters}x across projects, resolved successfully ${a.successes}x`,
		);

		return `## Cross-project error patterns (proven reliable)\n${lines.join("\n")}\n`;
	} catch {
		return "";
	}
}

/**
 * Reset all antibodies (for testing).
 */
export function resetImmuneMemory(): void {
	try {
		const filePath = getImmunePath();
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch {
		// Never crash
	}
}
