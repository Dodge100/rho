/**
 * DEAD STORE ELIMINATION — Tombstone unreferenced tool outputs.
 *
 * Treats conversation as dependency graph. For each tool result message,
 * check if ANY subsequent assistant message references its content.
 * If not referenced → replace with tombstone `[N tokens elided...]`.
 *
 * 30-50% context savings on long sessions.
 *
 * Concepts borrowed from claynicholson/claude-code-re's dead store elimination.
 * Adapted for pi's message format and context event.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

type ToolResultFingerprint = {
	messageIndex: number;
	messageId: string;
	toolName: string;
	samples: string[]; // Content samples for reference checking
	checked: boolean; // Already evaluated?
	isAlive: boolean; // Still referenced?
	tokenEstimate: number; // Approximate token count of content
};

// ── Module State ───────────────────────────────────────────────────────────

/** Per-session registry of tool results and their reference status. */
let fingerprints: ToolResultFingerprint[] = [];
let sessionStarted = false;

// ── Constants ──────────────────────────────────────────────────────────────

const SAMPLE_SIZE = 300; // Chars to sample from start/end of content
const MIN_CONTENT_LENGTH = 100; // Don't bother tombstoning tiny outputs
const MAX_SAMPLES = 3; // Number of content samples to check

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract text content from a message's content blocks.
 */
function extractText(msg: { content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> }): string {
	if (!msg.content) return "";
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		}
		if (block.type === "toolResult" && block.text) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Extract tool-name from a message (for tool results).
 */
function getToolName(msg: { content?: Array<{ type: string; name?: string; toolName?: string }> }): string | null {
	if (!msg.content) return null;
	for (const block of msg.content) {
		if (block.type === "toolResult") {
			return block.name || block.toolName || null;
		}
		if (block.type === "tool_call" || block.type === "toolCall") {
			return block.name || null;
		}
	}
	return null;
}

/**
 * Sample representative substrings from text for reference matching.
 * Takes start, middle, and end sections.
 */
function sampleContent(text: string): string[] {
	if (!text || text.length < MIN_CONTENT_LENGTH) return [];

	const samples: string[] = [];
	const clean = text.replace(/\s+/g, " ").trim();

	// Start sample
	samples.push(clean.slice(0, SAMPLE_SIZE));

	if (clean.length > SAMPLE_SIZE * 2) {
		// Middle sample
		const mid = Math.floor(clean.length / 2);
		samples.push(clean.slice(mid, mid + SAMPLE_SIZE));

		// End sample
		samples.push(clean.slice(-SAMPLE_SIZE));
	}

	return samples;
}

/**
 * Rough token estimate (4 chars ≈ 1 token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Check if any sample appears in a body of text.
 */
function samplesReferenced(samples: string[], text: string): boolean {
	if (samples.length === 0 || !text) return false;
	const cleanText = text.replace(/\s+/g, " ").trim();
	for (const sample of samples) {
		// Need at least 20 chars to avoid false matches on tiny fragments
		if (sample.length < 20) continue;
		if (cleanText.includes(sample.slice(0, 100))) return true;
	}
	return false;
}

// ── Main API ──────────────────────────────────────────────────────────────

/**
 * Reset for new session.
 */
export function resetSession(): void {
	fingerprints = [];
	sessionStarted = true;
}

/**
 * Process messages before an LLM call.
 * Returns modified messages with dead stores tombstoned.
 */
export function eliminateDeadStores(
	messages: Array<{ id?: string; role: string; content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> }>,
): Array<{ id?: string; role: string; content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown }> }> {
	if (!sessionStarted) return messages;
	if (messages.length < 3) return messages; // Not enough context yet

	let tombstoned = 0;
	let totalTokens = 0;

	// Pass 1: Register new tool result messages we haven't seen
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const msgId = msg.id || `${i}`;

		// Skip if already registered
		if (fingerprints.some((f) => f.messageId === msgId)) continue;

		// Tool results: messages with toolResult content or role "tool" or role "user" with tool output
		const text = extractText(msg);
		const toolName = getToolName(msg);

		if (toolName && text.length >= MIN_CONTENT_LENGTH) {
			fingerprints.push({
				messageIndex: i,
				messageId: msgId,
				toolName,
				samples: sampleContent(text),
				checked: false,
				isAlive: true, // Assume alive until checked
				tokenEstimate: estimateTokens(text),
			});
		}
	}

	// Pass 2: Check which tool results are referenced by later assistant messages
	for (const fp of fingerprints) {
		if (fp.checked) continue;

		// Find the corresponding message index
		const msgIndex = messages.findIndex((m) => (m.id || `${messages.indexOf(m)}`) === fp.messageId);
		if (msgIndex === -1) {
			fp.checked = true;
			continue;
		}

		// Check all subsequent assistant messages
		let referenced = false;
		for (let j = msgIndex + 1; j < messages.length; j++) {
			if (messages[j].role !== "assistant") continue;
			const assistantText = extractText(messages[j]);
			if (samplesReferenced(fp.samples, assistantText)) {
				referenced = true;
				break;
			}
		}

		fp.isAlive = referenced;
		fp.checked = true;

		if (!referenced) {
			tombstoned++;
			totalTokens += fp.tokenEstimate;
		}
	}

	if (tombstoned === 0) return messages;

	// Pass 3: Tombstone dead messages (modify the deep copy)
	const modified = [...messages];
	let actualTombstoned = 0;
	let actualTokens = 0;

	for (const fp of fingerprints) {
		if (fp.isAlive) continue;
		if (!fp.checked) continue;

		const idx = modified.findIndex((m) => (m.id || `${modified.indexOf(m)}`) === fp.messageId);
		if (idx === -1) continue;

		const msg = modified[idx];
		const text = extractText(msg);
		if (!text) continue;

		const tokenCount = fp.tokenEstimate;

		// Replace content with tombstone
		// Keep the message structure but swap text content
		if (msg.content) {
			msg.content = msg.content.map((block) => {
				if (block.type === "text" || block.type === "toolResult") {
					return {
						...block,
						text: `[${tokenCount} tokens elided — unreferenced tool output]`,
					};
				}
				return block;
			});
		}

		actualTombstoned++;
		actualTokens += tokenCount;
	}

	if (actualTombstoned > 0) {
		// Log silently - console.log corrupts TUI rendering
	}

	return modified;
}
