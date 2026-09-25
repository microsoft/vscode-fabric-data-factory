/**
 * Proactive conversation compaction for the `@di` chat participant
 * (see `docs/chat_steering_and_compaction.md` §2).
 *
 * When the running message array approaches the *current model's* input budget
 * (`model.maxInputTokens`), {@link compactIfNeeded} summarizes the older middle
 * turns into one compact note and keeps the system prompt + most-recent turns
 * verbatim. This bounds context growth so long multi-turn sessions don't drift
 * or hit the hard token limit. The budget is read live from the model, so it
 * adapts to whatever model the user has selected.
 *
 * The module is class-free: the chat participant injects what it needs
 * (the verified-facts ledger render + a mechanical fallback trim) via
 * {@link CompactionDeps}.
 */

import * as vscode from "vscode";
import { log, debug } from "@/utils/channel_log";

const COMPACT_RESERVED_OUTPUT_TOKENS = 8_000; // headroom reserved for the model's reply
const COMPACT_SAFETY = 0.8; // also cap usage at this fraction of the input window
const COMPACT_PREFILTER = 0.85; // only run the (costly) precise token count once chars/4 crosses this × budget
const COMPACT_MAX_MSG_CHARS = 1_500; // truncate each message when building the summary transcript

/** Collaborators the chat participant supplies to compaction. */
export interface CompactionDeps {
    /**
     * Render the current verified-facts ledger so observed values survive the
     * compaction verbatim (folded into the summary marker).
     */
    renderFacts: () => string;
    /**
     * Mechanical fallback used when the summarization model call fails — keeps
     * the system prompt + recent tail and drops the middle without an LLM round.
     */
    fallbackTrim: (messages: vscode.LanguageModelChatMessage[]) => vscode.LanguageModelChatMessage[];
}

/**
 * Flatten a chat message's parts to plain text. Used for the cheap token
 * pre-filter and for building the compaction summary transcript. Tool
 * calls/results are rendered compactly so the summary model can still reason
 * about what happened.
 */
function messageText(m: vscode.LanguageModelChatMessage): string {
    const content = m.content as unknown;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const out: string[] = [];
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            out.push(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            out.push(`[tool_call ${part.name}(${JSON.stringify(part.input)})]`);
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            for (const inner of (part.content as unknown[]) ?? []) {
                if (inner instanceof vscode.LanguageModelTextPart) out.push(inner.value);
            }
        }
    }
    return out.join("\n");
}

/**
 * Summarize the to-be-dropped middle of the conversation with a **separate,
 * tool-less** model call. Builds a bounded plain-text transcript (each message
 * truncated to {@link COMPACT_MAX_MSG_CHARS}) so the summary request itself
 * can't blow the budget, and asks for a tight, factual brief.
 */
async function summarizeDropped(
    model: vscode.LanguageModelChat,
    dropped: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
): Promise<string> {
    const roleName = (m: vscode.LanguageModelChatMessage) =>
        m.role === vscode.LanguageModelChatMessageRole.Assistant ? "Assistant" : "User";
    const transcript = dropped
        .map((m) => {
            let t = messageText(m).trim();
            if (t.length > COMPACT_MAX_MSG_CHARS) t = t.slice(0, COMPACT_MAX_MSG_CHARS) + " …[truncated]";
            return t ? `${roleName(m)}: ${t}` : "";
        })
        .filter((l) => l.length > 0)
        .join("\n\n");

    const instruction =
        "You are compacting the earlier part of a @di (Microsoft Fabric data-integration) chat session so the " +
        "assistant can continue without losing context. Summarize the TRANSCRIPT below into a tight brief that captures:\n" +
        "- the user's goal / task\n" +
        "- key decisions and the approach taken\n" +
        "- files, items, DAGs, tables touched (by name)\n" +
        "- verified facts & concrete values (row counts, statuses, ids) WITH their values\n" +
        "- what worked, what failed (and why)\n" +
        "- open threads / next steps\n" +
        "Be concise and factual. Do NOT invent anything — only use what's in the transcript. " +
        "Output plain prose/bullets, no preamble.\n\n" +
        "=== TRANSCRIPT ===\n" + transcript;

    const resp = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(instruction)],
        {},
        token,
    );
    let summary = "";
    for await (const part of resp.stream) {
        if (part instanceof vscode.LanguageModelTextPart) summary += part.value;
    }
    return summary.trim() || "(summary unavailable)";
}

/**
 * Proactively compact `messages` when they approach the *current model's* input
 * budget (`model.maxInputTokens`). Keeps the system prompt (index 0) and the
 * most-recent turns verbatim; replaces the older middle with a single
 * model-generated "earlier conversation summary" message that also carries the
 * verified-facts ledger forward.
 *
 * Returns the (possibly) compacted array. Always on — no setting. Cheap by
 * default: a `chars/4` pre-filter avoids the per-message tokenizer round-trips
 * until we're plausibly near the budget. Best-effort: any failure falls back to
 * `deps.fallbackTrim`.
 */
export async function compactIfNeeded(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    stream: vscode.ChatResponseStream,
    deps: CompactionDeps,
): Promise<vscode.LanguageModelChatMessage[]> {
    if (messages.length <= 4 || !model.maxInputTokens) return messages;

    const budget = Math.min(
        model.maxInputTokens - COMPACT_RESERVED_OUTPUT_TOKENS,
        Math.floor(model.maxInputTokens * COMPACT_SAFETY),
    );
    if (budget <= 0) return messages;

    // Cheap pre-filter (~4 chars/token): skip the tokenizer round-trips
    // unless we're plausibly near the budget.
    const approxChars = messages.reduce((n, m) => n + messageText(m).length, 0);
    if (approxChars / 4 < budget * COMPACT_PREFILTER) return messages;

    // Precise count via the model's own tokenizer.
    let used = 0;
    try {
        for (const m of messages) used += await model.countTokens(m, token);
    } catch {
        used = Math.ceil(approxChars / 4); // tokenizer unavailable/cancelled — use the estimate
    }
    if (used <= budget) return messages;

    debug(`[di-chat] Compaction: used≈${used} tok > budget ${budget} (maxInput=${model.maxInputTokens}); compacting ${messages.length} msgs`);
    stream.progress("Compacting earlier conversation…");

    // Preserve the system prompt; keep the most-recent half verbatim, snapped
    // to start on an Assistant message so a kept `tool_result` has its parent
    // `tool_use` (mirrors the chat participant's mechanical recovery trim).
    const headKeep = 1;
    const tailKeep = Math.max(2, Math.floor((messages.length - headKeep) / 2));
    let tailStart = messages.length - tailKeep;
    while (tailStart < messages.length
        && messages[tailStart].role !== vscode.LanguageModelChatMessageRole.Assistant) {
        tailStart++;
    }
    if (tailStart <= headKeep) return messages; // nothing meaningful to drop

    const head = messages.slice(0, headKeep);
    const dropped = messages.slice(headKeep, tailStart);
    const tail = messages.slice(tailStart);
    if (dropped.length === 0) return messages;

    try {
        const summary = await summarizeDropped(model, dropped, token);
        const facts = deps.renderFacts();
        const marker = vscode.LanguageModelChatMessage.User(
            `[Earlier conversation summary — ${dropped.length} older message(s) were compacted to stay within the ` +
            `model's context window. Treat this as authoritative for what happened before; continue from here.\n\n` +
            `${summary.trim()}` +
            (facts ? `\n\nVerified facts (still valid — keep citing these instead of re-asserting from memory):\n${facts}` : "") +
            `]`,
        );
        log(`[di-chat] Compacted ${dropped.length} msg(s) → 1 summary (${messages.length} → ${head.length + 1 + tail.length} messages)`);
        return [...head, marker, ...tail];
    } catch (e) {
        debug(`[di-chat] Compaction summary failed (${(e as Error).message}); falling back to mechanical trim`);
        return deps.fallbackTrim(messages);
    }
}
