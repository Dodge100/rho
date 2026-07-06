/**
 * WF-WakaTime — Bridge workflow subagent activity to WakaTime.
 *
 * pi-wakatime tracks top-level session events (turn_start, tool_call, tool_result)
 * but workflow subagents run in isolated sessions invisible to it. This extension
 * fills the gap by intercepting WorkflowManager agent events and sending WakaTime
 * heartbeats for each subagent and its file operations.
 *
 * Requires:
 *   - pi-wakatime (or wakatime-cli available in PATH or ~/.wakatime/)
 *   - pi-dynamic-workflows (for WorkflowManager class)
 *   - ~/.wakatime.cfg with api_key configured
 *
 * Install: place in ~/.pi/agent/extensions/wf-wakatime.ts and /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const _require = createRequire(import.meta.url);

// ── Module state ──────────────────────────────────────────────────────────

let wakaCliPath: string | null = null;

/** Synthetic entity used for session-level workflow heartbeats. */
const WF_SESSION_ENTITY = ".pi-workflow";

/** Build plugin string for WakaTime attribution. */
function pluginString(): string {
	const piVersion = getPackageVersion("@earendil-works/pi-coding-agent") || "unknown";
	return `pi-coding-agent/${piVersion} wf-wakatime/1.0`;
}

// ── WakaTime CLI discovery ────────────────────────────────────────────────

/**
 * Find the wakatime-cli binary:
 * 1. PATH (global install)
 * 2. ~/.wakatime/wakatime-cli  (pi-wakatime local install)
 * 3. ~/.wakatime/wakatime-cli-{os}-{arch}  (raw download from pi-wakatime)
 */
function findWakaCli(): string | null {
	if (wakaCliPath) return wakaCliPath;

	const candidates: string[] = [];
	const home = process.env.HOME || os.homedir();
	const wakaDir = path.join(home, ".wakatime");

	// PATH check
	try {
		const which = process.platform === "win32" ? "where" : "which";
		const result = execFileSync(which, ["wakatime-cli"], {
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const loc = result.stdout?.trim().split(/\r?\n/)[0];
		if (loc) {
			wakaCliPath = loc;
			return loc;
		}
	} catch {
		// Not in PATH
	}

	// ~/.wakatime/ candidates
	const ext = process.platform === "win32" ? ".exe" : "";
	candidates.push(path.join(wakaDir, `wakatime-cli${ext}`));

	// os-arch variant (pi-wakatime downloads as: wakatime-cli-{os}-{arch})
	try {
		const arch = os.arch().includes("x64") ? "amd64" : os.arch();
		const osName = process.platform === "win32" ? "windows" : process.platform;
		candidates.push(path.join(wakaDir, `wakatime-cli-${osName}-${arch}${ext}`));
	} catch {
		// ignore
	}

	for (const c of candidates) {
		if (fs.existsSync(c)) {
			wakaCliPath = c;
			return c;
		}
	}

	return null;
}

// ── WakaTime heartbeat sending ────────────────────────────────────────────

/**
 * Send a WakaTime heartbeat via the CLI.
 * Fire-and-forget — never blocks or crashes the extension.
 */
function sendHeartbeat(args: string[]): void {
	const cli = wakaCliPath || findWakaCli();
	if (!cli) return;

	const allArgs = [
		...args,
		"--plugin", pluginString(),
		"--sync-ai-disabled",
	];

	execFile(cli, allArgs, {
		timeout: 15_000,
		windowsHide: true,
		env: { ...process.env },
	}, () => {
		// Best-effort: silently ignore failures (no CLI, no API key, offline, etc.)
	});
}

// ── Event handlers ────────────────────────────────────────────────────────

/** Agent started → session heartbeat. */
function onAgentStart(data: {
	runId: string;
	label: string;
	phase?: string;
	model?: string;
}): void {
	if (!wakaCliPath && !findWakaCli()) return;

	const cwd = process.cwd();
	const desc = data.phase
		? `wf/${data.phase}: ${data.label}`
		: `wf: ${data.label}`;

	sendHeartbeat([
		"--entity", path.join(cwd, WF_SESSION_ENTITY),
		"--entity-type", "file",
		"--is-unsaved-entity",
		"--project-folder", cwd,
		"--category", "coding",
		"--description", desc,
	]);
}

/** Agent finished → session heartbeat (with token estimate as AI line changes). */
function onAgentEnd(data: {
	runId: string;
	label: string;
	result?: unknown;
	tokens?: number;
	model?: string;
}): void {
	if (!wakaCliPath && !findWakaCli()) return;

	const cwd = process.cwd();
	const args = [
		"--entity", path.join(cwd, WF_SESSION_ENTITY),
		"--entity-type", "file",
		"--is-unsaved-entity",
		"--project-folder", cwd,
		"--category", "coding",
	];

	// Rough proxy: treat ~10 tokens as 1 line of AI work
	if (typeof data.tokens === "number" && data.tokens > 0) {
		const lines = Math.max(1, Math.ceil(data.tokens / 10));
		args.push("--ai-line-changes", String(lines));
	}

	sendHeartbeat(args);
}

/** Extract file paths from agent history and send file heartbeats. */
function onAgentHistory(data: {
	runId: string;
	label: string;
	history?: Array<{
		role: string;
		kind: string;
		text: string;
		toolName?: string;
		isError?: boolean;
	}>;
}): void {
	if (!wakaCliPath && !findWakaCli()) return;
	if (!data.history?.length) return;

	const cwd = process.cwd();

	for (const entry of data.history) {
		// Only process toolCalls (assistant requesting a tool) — these have
		// the structured arguments including file path.
		if (entry.kind !== "toolCall") continue;
		if (entry.toolName !== "read" && entry.toolName !== "write" && entry.toolName !== "edit") continue;

		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(entry.text) as Record<string, unknown>;
		} catch {
			continue;
		}

		// Extract file path from various argument shapes
		const rawPath = (parsed.path ?? parsed.file ?? parsed.file_path) as string | undefined;
		if (!rawPath) continue;

		const entity = path.resolve(cwd, rawPath);

		const hbArgs = [
			"--entity", entity,
			"--entity-type", "file",
			"--project-folder", cwd,
		];

		if (entry.toolName === "write" || entry.toolName === "edit") {
			hbArgs.push("--write");

			// Estimate line changes
			let lineChanges = 0;
			if (entry.toolName === "write" && typeof parsed.content === "string") {
				lineChanges = parsed.content.split(/\r?\n/).length;
			} else if (entry.toolName === "edit" && Array.isArray(parsed.edits)) {
				for (const edit of parsed.edits) {
					if (edit && typeof edit === "object") {
						const oldLines = typeof edit.oldText === "string" ? edit.oldText.split(/\r?\n/).length : 0;
						const newLines = typeof edit.newText === "string" ? edit.newText.split(/\r?\n/).length : 0;
						lineChanges += Math.max(oldLines, newLines);
					}
				}
			}

			if (lineChanges > 0) {
				hbArgs.push("--category", "ai coding", "--ai-line-changes", String(lineChanges));
			} else {
				hbArgs.push("--category", "coding");
			}
		} else {
			hbArgs.push("--category", "coding");
		}

		sendHeartbeat(hbArgs);
	}
}

/** Workflow completed → final session heartbeat with aggregate stats. */
function onWorkflowComplete(data: {
	runId: string;
	result?: { agentCount?: number; tokenUsage?: { total: number } };
}): void {
	if (!wakaCliPath && !findWakaCli()) return;

	const cwd = process.cwd();
	const result = data.result;
	const ag = result?.agentCount ?? 0;
	const tok = result?.tokenUsage?.total ?? 0;
	const lines = tok > 0 ? Math.max(1, Math.ceil(tok / 10)) : 0;

	const args = [
		"--entity", path.join(cwd, WF_SESSION_ENTITY),
		"--entity-type", "file",
		"--is-unsaved-entity",
		"--project-folder", cwd,
		"--category", "coding",
		"--description", `workflow complete: ${ag} agents`,
	];
	if (lines > 0) {
		args.push("--ai-line-changes", String(lines));
	}
	sendHeartbeat(args);
}

/** Workflow errored → no-op (could send error heartbeat if needed). */
function onWorkflowError(_data: { runId: string; error?: Error }): void {
	// no-op
}

// ── Package version helper ────────────────────────────────────────────────

function getPackageVersion(pkg: string): string | null {
	try {
		const pj = _require(`${pkg}/package.json`);
		return pj?.version ?? null;
	} catch {
		return null;
	}
}

// ── Extension entry point ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Probe for wakatime-cli at startup
	findWakaCli();

	// ── Intercept WorkflowManager events ──────────────────────────────────
	//
	// pi-dynamic-workflows creates a WorkflowManager instance as a local
	// variable inside its extension. We can't reach that instance directly,
	// so we add an `emit` method to WorkflowManager.prototype that shadows
	// EventEmitter.prototype.emit — this catches events from ALL
	// WorkflowManager instances without affecting other EventEmitter users.

	const origProtoEmit = EventEmitter.prototype.emit;

	try {
		const wfModule = _require("@quintinshaw/pi-dynamic-workflows");
		const WorkflowManager = wfModule.WorkflowManager;

		if (WorkflowManager?.prototype) {
			(WorkflowManager.prototype as unknown as { emit: typeof origProtoEmit }).emit =
				function (this: unknown, event: string, ...args: unknown[]) {
					const firstArg = args[0] as Record<string, unknown> | undefined;

					if (firstArg) {
						switch (event) {
							case "agentStart":
								onAgentStart(firstArg as Parameters<typeof onAgentStart>[0]);
								break;
							case "agentEnd":
								onAgentEnd(firstArg as Parameters<typeof onAgentEnd>[0]);
								break;
							case "agentHistory":
								onAgentHistory(firstArg as Parameters<typeof onAgentHistory>[0]);
								break;
							case "complete":
								onWorkflowComplete(firstArg as Parameters<typeof onWorkflowComplete>[0]);
								break;
							case "error":
								onWorkflowError(firstArg as Parameters<typeof onWorkflowError>[0]);
								break;
						}
					}

					return origProtoEmit.call(this, event, ...args);
				};
		}
	} catch {
		// pi-dynamic-workflows not installed — nothing to bridge
	}

	// ── Status command ────────────────────────────────────────────────────

	pi.registerCommand("wf-wakatime", {
		description: "Check wf-wakatime bridge status",
		handler: async (_args, ctx) => {
			const cli = findWakaCli();
			let wfAvailable = false;
			try {
				_require("@quintinshaw/pi-dynamic-workflows");
				wfAvailable = true;
			} catch {
				// not available
			}
			const lines = [
				`wf-wakatime status:`,
				`  wakatime-cli: ${cli ?? "NOT FOUND (install pi-wakatime first)"}`,
				`  pi-dynamic-workflows: ${wfAvailable ? "available" : "NOT AVAILABLE"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
