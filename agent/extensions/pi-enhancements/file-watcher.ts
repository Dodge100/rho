/**
 * FILE WATCHER — Stale file detection.
 *
 * After a file is read or written successfully, record its mtime.
 * Before the model runs, check if any tracked files have changed (user edited
 * in an external editor). If so, inject a one-shot stale warning.
 *
 * No fs.watch() — uses mtime polling for simplicity and cross-platform safety.
 * No LRU — bounded by max tracked files, oldest evicted on overflow.
 */

import * as fs from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

type TrackedFile = {
	path: string;
	knownMtime: number; // ms timestamp
	trackedAt: number; // when we started tracking
};

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_TRACKED_FILES = 50;
const STALE_WARNING = `⚠️  **Stale file warning:** The following file(s) have been modified externally since pi last read them. Re-read them before acting on their content to avoid working with outdated data.`;

// ── State ──────────────────────────────────────────────────────────────────

const tracked: Map<string, TrackedFile> = new Map();
const warned: Set<string> = new Set(); // One-shot warnings

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Track a file after a successful read or write.
 * Call from tool_result handler for Read/Write/Edit tools.
 */
export function trackFile(filePath: string): void {
	try {
		const stat = fs.statSync(filePath);
		const entry: TrackedFile = {
			path: filePath,
			knownMtime: stat.mtimeMs,
			trackedAt: Date.now(),
		};
		tracked.set(filePath, entry);

		// Remove from warned set so it can warn again if re-read
		warned.delete(filePath);

		// Evict oldest if over limit
		if (tracked.size > MAX_TRACKED_FILES) {
			let oldest: string | null = null;
			let oldestTime = Infinity;
			for (const [p, t] of tracked) {
				if (t.trackedAt < oldestTime) {
					oldestTime = t.trackedAt;
					oldest = p;
				}
			}
			if (oldest) {
				tracked.delete(oldest);
				warned.delete(oldest);
			}
		}
	} catch {
		// File might not exist yet (e.g., Write creates it)
	}
}

/**
 * Check all tracked files for external modifications.
 * Returns a formatted warning string, or empty string if nothing stale.
 * Clears tracked files after warning (one-shot per change).
 */
export function checkStaleFiles(): string {
	const stale: string[] = [];

	for (const [filePath, entry] of tracked) {
		// Skip if already warned for this modification
		if (warned.has(filePath)) continue;

		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs > entry.knownMtime) {
				stale.push(filePath);
				warned.add(filePath);
			}
		} catch {
			// File was deleted — also note it
			stale.push(`${filePath} (missing)`);
			warned.add(filePath);
		}
	}

	if (stale.length === 0) return "";

	return `${STALE_WARNING}\n${stale.map((f) => `- \`${f}\``).join("\n")}\n`;
}

/**
 * Remove a specific file from tracking (e.g., after it's been re-read).
 */
export function untrackFile(filePath: string): void {
	tracked.delete(filePath);
	warned.delete(filePath);
}

/** Reset all tracked files (call on session_start / session_shutdown). */
export function resetFileWatcher(): void {
	tracked.clear();
	warned.clear();
}
