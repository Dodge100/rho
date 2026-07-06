/**
 * SCAR TISSUE — Cross-session failure memory.
 *
 * When a tool fails, record a "scar" — structured record of what was
 * attempted and what went wrong. Scars persist across sessions and are
 * injected early in future sessions so pi never makes the same mistake twice.
 *
 * Concepts borrowed from claynicholson/claude-code-re's scar tissue system.
 * Simplified for pi's extension model.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

export type Scar = {
	id: string;
	pattern: string; // What was attempted (normalized)
	failure: string; // What went wrong
	resolution: string | null; // What eventually worked (if known)
	context: {
		toolName: string;
		errorClass: string; // Normalized error type
		filePattern: string; // File or path pattern involved
		project: string; // Project identifier
	};
	hitCount: number; // Raw integer — times this error occurred (never decays)
	lastSeen: number; // Timestamp
	created: number; // Timestamp
};

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_SCARS = 200;
const DECAY_HALF_LIFE_DAYS = 30;
const MIN_HITS_TO_INJECT = 2; // Persistent scars: must be hit at least twice

// Session-level error journal (in-memory, survives compaction)
const MAX_SESSION_ERRORS = 30;
const sessionErrors: Map<string, { scar: Scar; turnIndex: number }> = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function getScarsDir(): string {
	const agentDir = getAgentDir();
	return path.join(agentDir, "scars");
}

function getGlobalScarsPath(): string {
	return path.join(getScarsDir(), "global.json");
}

function getProjectScarsPath(projectId: string): string {
	return path.join(getScarsDir(), `${projectId}.json`);
}

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function loadScars(filePath: string): Scar[] {
	if (!fs.existsSync(filePath)) return [];
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return [];
	}
}

function saveScars(filePath: string, scars: Scar[]): void {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, JSON.stringify(scars, null, 2));
}

/**
 * Generate fingerprint for deduplication.
 * Same (toolName, errorClass, filePattern) → same scar.
 */
function fingerprint(toolName: string, errorClass: string, filePattern: string): string {
	return `${toolName}:${errorClass}:${filePattern}`;
}

/**
 * Normalize error message to an error class.
 * Strips machine-specific details, line numbers, etc.
 */
function normalizeErrorClass(errorMsg: string): string {
	let msg = errorMsg;

	// Path patterns → <PATH>
	msg = msg.replace(/(\/[\w.-]+)+/g, "<PATH>");
	// Version numbers → <VERSION>
	msg = msg.replace(/\d+\.\d+\.\d+/g, "<VERSION>");
	// Numbers → <NUM>
	msg = msg.replace(/\d{2,}/g, "<NUM>");
	// Hashes → <HASH>
	msg = msg.replace(/[a-f0-9]{8,}/gi, "<HASH>");
	// Trim and limit
	msg = msg.slice(0, 200);

	return msg;
}

/**
 * Extract file paths from tool input or error message.
 */
function extractFilePattern(input: unknown, errorMsg: string): string {
	const combined = typeof input === "string" ? input : JSON.stringify(input);
	const text = `${combined} ${errorMsg}`;

	// Match file-like patterns
	const patterns = text.match(/(\/[\w.\-/]+\.\w+)/g);
	if (patterns && patterns.length > 0) {
		// Take the most specific (longest) path
		return patterns.sort((a, b) => b.length - a.length)[0];
	}

	// Match paths without extensions
	const pathPatterns = text.match(/(\/[\w.\-/]+)/g);
	if (pathPatterns && pathPatterns.length > 0) {
		return pathPatterns.sort((a, b) => b.length - a.length)[0];
	}

	return "<unknown>";
}

/**
 * Get a project identifier from cwd.
 * Uses git remote if available, else directory basename.
 */
function getProjectId(cwd: string): string {
	try {
		const { execSync } = require("node:child_process");
		const remote = execSync("git config --get remote.origin.url", {
			cwd,
			encoding: "utf8",
			timeout: 3000,
		}).trim();
		if (remote) {
			return remote
				.replace(/^https?:\/\//, "")
				.replace(/\.git$/, "")
				.replace(/[\/:]/g, "-");
		}
	} catch {
		// No git remote, fall through
	}
	return path.basename(cwd) || "unknown";
}

// ── Decay ──────────────────────────────────────────────────────────────────

/**
 * Compute decayed confidence for ranking. hitCount * 0.5^(days/DECAY_HALF_LIFE_DAYS).
 * hitCount itself never mutates — raw integer for threshold checks.
 */
function decayedConfidence(scar: Scar): number {
	const elapsedDays = (Date.now() - scar.lastSeen) / (1000 * 60 * 60 * 24);
	const halfLives = elapsedDays / DECAY_HALF_LIFE_DAYS;
	return scar.hitCount * Math.pow(0.5, halfLives);
}

/**
 * Should keep? Returns true to keep scar. Prunes only when decayed
 * confidence < 0.5 AND it's been >= DECAY_HALF_LIFE_DAYS since last seen.
 */
function shouldKeep(scar: Scar): boolean {
	const elapsedDays = (Date.now() - scar.lastSeen) / (1000 * 60 * 60 * 24);
	if (elapsedDays < DECAY_HALF_LIFE_DAYS) return true;
	return decayedConfidence(scar) >= 0.5;
}

// ── Session-level error journal ───────────────────────────────────────────

let currentTurn = 0;

/** Set the current turn index (call from tool_result tracking). */
export function setCurrentTurn(turn: number): void {
	currentTurn = turn;
}

/**
 * Record a session-scoped error (no persistence, survives compaction).
 * Deduped by same fingerprint as persistent scars.
 */
export function recordSessionError(
	toolName: string,
	input: unknown,
	errorMsg: string,
): void {
	const filePattern = extractFilePattern(input, errorMsg);
	const errorClass = normalizeErrorClass(errorMsg);
	const fp = fingerprint(toolName, errorClass, filePattern);

	const now = Date.now();

	if (sessionErrors.has(fp)) {
		const entry = sessionErrors.get(fp)!;
		entry.scar.hitCount += 1;
		entry.scar.lastSeen = now;
		entry.scar.failure = errorMsg.slice(0, 300);
		entry.turnIndex = currentTurn;
	} else {
		sessionErrors.set(fp, {
			scar: {
				id: fp,
				pattern: `${toolName} → ${errorClass}`,
				failure: errorMsg.slice(0, 300),
				resolution: null,
				context: { toolName, errorClass, filePattern, project: "" },
				hitCount: 1,
				lastSeen: now,
				created: now,
			},
			turnIndex: currentTurn,
		});
	}

	// Keep bounded
	if (sessionErrors.size > MAX_SESSION_ERRORS) {
		const oldest = [...sessionErrors.entries()]
			.sort(([, a], [, b]) => a.turnIndex - b.turnIndex)[0];
		if (oldest) sessionErrors.delete(oldest[0]);
	}
}

/** Reset session error journal (call on session_start / session_shutdown). */
export function resetSessionErrors(): void {
	sessionErrors.clear();
	currentTurn = 0;
}

/**
 * Get session error context for a specific tool, deduped against already-known persistent scars.
 * Returns formatted string or empty string if nothing to inject.
 */
export function getSessionErrorsContext(toolName: string, projectId: string): string {
	if (sessionErrors.size === 0) return "";

	// Load persistent scars to avoid duplicating what's already known
	const persistentIds = new Set<string>();
	try {
		const globalScars = loadScars(getGlobalScarsPath());
		const projectScars = loadScars(getProjectScarsPath(projectId));
		for (const s of [...globalScars, ...projectScars]) {
			if (s.hitCount >= MIN_HITS_TO_INJECT) persistentIds.add(s.id);
		}
	} catch { /* squash */ }

	// Get tool-relevant session errors that are NOT already in persistent scars
	const relevant = [...sessionErrors.values()]
		.filter((e) => e.scar.context.toolName === toolName && !persistentIds.has(e.scar.id))
		.sort((a, b) => b.scar.lastSeen - a.scar.lastSeen)
		.slice(0, 3);

	if (relevant.length === 0) return "";

	const lines = relevant.map(
		(e) =>
			`- ${e.scar.pattern}: ${e.scar.failure} (${e.scar.hitCount}x this session)`,
	);

	return `## Recent errors this session (${toolName})
${lines.join("\n")}
`;
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Record a tool failure as a scar.
 */
export function recordScar(
	toolName: string,
	input: unknown,
	errorMsg: string,
	projectId: string,
	cwd: string,
): void {
	try {
		const filePattern = extractFilePattern(input, errorMsg);
		const errorClass = normalizeErrorClass(errorMsg);
		const fp = fingerprint(toolName, errorClass, filePattern);

		const now = Date.now();
		const scar: Scar = {
			id: fp,
			pattern: `${toolName} → ${errorClass}`,
			failure: errorMsg.slice(0, 300),
			resolution: null,
			context: { toolName, errorClass, filePattern, project: projectId },
			hitCount: 1,
			lastSeen: now,
			created: now,
		};

		// Update global scars
		const globalPath = getGlobalScarsPath();
		const globalScars = loadScars(getGlobalScarsPath());
		const existingGlobal = globalScars.find((s) => s.id === fp);
		if (existingGlobal) {
			existingGlobal.hitCount += 1;
			existingGlobal.lastSeen = now;
			existingGlobal.failure = errorMsg.slice(0, 300);
		} else {
			globalScars.push(scar);
		}
		saveScars(getGlobalScarsPath(), globalScars.filter(shouldKeep).slice(-MAX_SCARS));

		// Update project scars
		const projectScars = loadScars(getProjectScarsPath(projectId));
		const existingProject = projectScars.find((s) => s.id === fp);
		if (existingProject) {
			existingProject.hitCount += 1;
			existingProject.lastSeen = now;
			existingProject.failure = errorMsg.slice(0, 300);
		} else {
			projectScars.push(scar);
		}
		saveScars(getProjectScarsPath(projectId), projectScars.filter(shouldKeep).slice(-MAX_SCARS));
	} catch {
		// Never crash the host
	}
}

/**
 * Record that a previously-failed operation succeeded (resolution).
 */
export function recordResolution(
	toolName: string,
	input: unknown,
	projectId: string,
): void {
	try {
		// Match against recent scars where input has similar file patterns
		const globalScars = loadScars(getGlobalScarsPath());
		const filePattern = extractFilePattern(input, "");

		const match = globalScars.find(
			(s) => s.context.toolName === toolName && s.context.filePattern === filePattern && !s.resolution,
		);
		if (match) {
			match.resolution = `Resolved successfully on ${new Date().toISOString().slice(0, 10)}`;
			saveScars(getGlobalScarsPath(), globalScars.filter(shouldKeep).slice(-MAX_SCARS));
		}
	} catch {
		// Never crash
	}
}

/**
 * Get scars relevant to the current context, formatted as text.
 */
export function getRelevantScarsContext(toolName: string, projectId: string): string {
	try {
		const globalScars = loadScars(getGlobalScarsPath());
		const projectScars = loadScars(getProjectScarsPath(projectId));

		// Merge: project scars override global for same fingerprint
		const scarMap = new Map<string, Scar>();
		for (const s of globalScars) {
			if (s.hitCount >= MIN_HITS_TO_INJECT) {
				scarMap.set(s.id, s);
			}
		}
		for (const s of projectScars) {
			if (s.hitCount >= MIN_HITS_TO_INJECT) {
				scarMap.set(s.id, s);
			}
		}

		// Filter to tool-relevant scars
		const relevant = Array.from(scarMap.values())
			.filter((s) => s.context.toolName === toolName)
			.sort((a, b) => b.hitCount - a.hitCount)
			.slice(0, 5);

		if (relevant.length === 0) return "";

		const lines = relevant.map(
			(s) =>
				`- ${s.pattern}: ${s.failure}${s.resolution ? ` → Fixed: ${s.resolution}` : ""} (${s.hitCount}x)`,
		);

		return `## Known failure patterns for ${toolName}\n${lines.join("\n")}\n\n`;
	} catch {
		return "";
	}
}

/**
 * Get ALL relevant scars for the project (any tool), formatted.
 */
export function getAllRelevantScarsContext(projectId: string): string {
	try {
		const globalScars = loadScars(getGlobalScarsPath());
		const projectScars = loadScars(getProjectScarsPath(projectId));

		const scarMap = new Map<string, Scar>();
		for (const s of globalScars) {
			if (s.hitCount >= MIN_HITS_TO_INJECT) scarMap.set(s.id, s);
		}
		for (const s of projectScars) {
			if (s.hitCount >= MIN_HITS_TO_INJECT) scarMap.set(s.id, s);
		}

		const relevant = Array.from(scarMap.values())
			.sort((a, b) => b.hitCount - a.hitCount)
			.slice(0, 8);

		if (relevant.length === 0) return "";

		const lines = relevant.map(
			(s) =>
				`- [${s.context.toolName}] ${s.pattern}: ${s.failure}${s.resolution ? ` → ${s.resolution}` : ""} (${s.hitCount}x)`,
		);

		return `## Past failure patterns (learned from previous sessions)\n${lines.join("\n")}\n`;
	} catch {
		return "";
	}
}
