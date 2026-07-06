/**
 * Pi Enhancements — Cross-session failure memory, dead store elimination, loop detector.
 *
 * Concepts from claynicholson/claude-code-re's CHIMERA project.
 *
 * Auto-compaction handled by pi-ultra-compact (install with: pi install npm:pi-ultra-compact)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	recordScar,
	recordResolution,
	recordSessionError,
	getSessionErrorsContext,
	resetSessionErrors,
	getAllRelevantScarsContext,
} from "./scar-tissue.ts";
import { eliminateDeadStores, resetSession as resetDeadStoreSession } from "./dead-store.ts";
import {
	recordToolCall,
	detectLoop,
	resetSession as resetLoopSession,
} from "./loop-detector.ts";
import { trackFile, checkStaleFiles, resetFileWatcher } from "./file-watcher.ts";
import {
	recordErrorEncounter,
	recordImmuneResolution,
	getImmuneContext,
} from "./immune-memory.ts";

export default function (pi: ExtensionAPI) {
	// ── Session lifecycle ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		resetDeadStoreSession();
		resetLoopSession();
		resetSessionErrors();
		resetFileWatcher();

		// Inject persistent scars + immune memory at session start
		const projectId = getProjectId(ctx.cwd);
		const scarsContext = getAllRelevantScarsContext(projectId);
		const immuneContext = getImmuneContext(projectId);

		const parts = [scarsContext, immuneContext].filter(Boolean);
		if (parts.length > 0) {
			return {
				message: {
					customType: "scar-tissue",
					content: parts.join("\n"),
					display: false,
				},
			};
		}
	});

	pi.on("session_shutdown", async () => {
		resetDeadStoreSession();
		resetLoopSession();
		resetSessionErrors();
		resetFileWatcher();
	});

	// ── Scar Tissue + Immune Memory: Record failures on tool errors ───────

	pi.on("tool_result", async (event, ctx) => {
		const { toolName, input, isError, content } = event;

		if (isError) {
			const errorMsg = extractError(content);
			if (errorMsg) {
				const projectId = getProjectId(ctx.cwd);
				const errorClass = normalizeErrorClass(errorMsg);
				recordScar(toolName, input, errorMsg, projectId, ctx.cwd);
				recordSessionError(toolName, input, errorMsg);
				recordErrorEncounter(errorClass, toolName);
			}
		} else {
			const projectId = getProjectId(ctx.cwd);
			recordResolution(toolName, input, projectId);
		}

		// File Watcher: Track files after successful read/write
		if (!isError) {
			trackFilesFromTool(toolName, input);
		}

		// Loop Detector: Track all tool calls
		recordToolCall(toolName, input, isError);
	});

	// ── Dead Store Elimination + Session Errors + Stale Files + Loop Detector ──

	pi.on("context", async (event, ctx) => {
		let messages = event.messages;

		// Dead store elimination
		messages = eliminateDeadStores(messages as any);

		// Session error re-injection (survives compaction, deduped vs persistent scars)
		const projectId = getProjectId(ctx.cwd);
		const lastToolCall = findLastToolCall(messages as any);
		if (lastToolCall) {
			const errorContext = getSessionErrorsContext(lastToolCall, projectId);
			if (errorContext) {
				messages = [
					...messages,
					{
						role: "user",
						content: [{ type: "text", text: errorContext }],
					},
				];
			}
		}

		// Stale file warning
		const staleWarning = checkStaleFiles();
		if (staleWarning) {
			messages = [
				...messages,
				{
					role: "user",
					content: [{ type: "text", text: staleWarning }],
				},
			];
		}

		// Loop detector injection
		const loopWarning = detectLoop();
		if (loopWarning) {
			messages = [
				...messages,
				{
					role: "user",
					content: [{ type: "text", text: loopWarning }],
				},
			];
		}

		return { messages };
	});

}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract file paths from a tool result and track them for stale detection.
 */
function trackFilesFromTool(toolName: string, input: unknown): void {
	if (!input || typeof input !== "object") return;
	const obj = input as Record<string, unknown>;

	switch (toolName) {
		case "Read":
		case "Write":
		case "Edit":
			if (typeof obj.file_path === "string") {
				trackFile(obj.file_path);
			}
			break;
	}

	if (typeof (obj as any).file === "string") {
		trackFile((obj as any).file);
	}
	if (typeof (obj as any).path === "string" && (obj as any).path.startsWith("/")) {
		trackFile((obj as any).path);
	}
}

/**
 * Normalize error message to an error class (shared with scar-tissue).
 */
function normalizeErrorClass(errorMsg: string): string {
	let msg = errorMsg;
	msg = msg.replace(/(\/[\w.-]+)+/g, "<PATH>");
	msg = msg.replace(/\d+\.\d+\.\d+/g, "<VERSION>");
	msg = msg.replace(/\d{2,}/g, "<NUM>");
	msg = msg.replace(/[a-f0-9]{8,}/gi, "<HASH>");
	return msg.slice(0, 200);
}

/**
 * Find the last tool call name from assistant messages.
 * Used to scope session error injection to the current tool.
 */
function findLastToolCall(messages: Array<{ role: string; content?: Array<{ type: string; name?: string }> }>): string | null {
	// Walk backwards to find the most recent assistant tool_use
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant" && msg.content) {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const block = msg.content[j];
				if (block.type === "tool_use" && block.name) {
					return block.name;
				}
			}
		}
	}
	return null;
}

/**
 * Extract error text from tool result content.
 */
function extractError(content: Array<{ type: string; text?: string }> | undefined): string | null {
	if (!content) return null;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			// Find error-like content
			const text = block.text;
			if (
				text.includes("Error") ||
				text.includes("error") ||
				text.includes("failed") ||
				text.includes("Failed") ||
				text.includes("not found") ||
				text.includes("No such file") ||
				text.includes("Cannot") ||
				text.includes("permission") ||
				text.includes("ENOENT") ||
				text.includes("EACCES") ||
				text.includes("SyntaxError") ||
				text.includes("TypeError") ||
				text.includes("exit code")
			) {
				return text.slice(0, 500);
			}
		}
	}
	return null;
}

/**
 * Get a project identifier from cwd.
 */
function getProjectId(cwd: string): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
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
		// No git remote
	}
	const parts = cwd.split("/");
	return parts[parts.length - 1] || "unknown";
}
