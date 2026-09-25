/**
 * Ground Truth guard (action #3 in docs/sdk_and_prompt_enhancement.md).
 *
 * Backs the agent-loop guard that refuses to let a turn finalize a LIVE-data
 * answer (row counts, run/task status, sizes, connection/item lists,
 * "succeeded / landed / is empty") when the model ran NO successful
 * data-reading tool that request. The loop nudges the model exactly once to
 * re-derive the value with a tool instead of asserting it from memory.
 *
 * Kept in its own module so the lexical heuristic + the nudge copy live
 * together and can be unit-tested / localized independently of the chat loop.
 */

/**
 * User-turn message injected (once) when an unverified live-data claim is
 * detected.
 *
 * Offers three exits, not two. The heuristic below cannot tell a live value
 * from a documented one — `previewTable returns the first 10 rows` trips the
 * numeric branch exactly like `the table has 541,909 rows` — so a nudge that
 * only allows "run a tool" or "say I have not verified this" corners the model
 * into apologising for, and hedging, a fact that was never live. The wording is
 * also deliberately non-accusatory and bans meta-narration: the user asked a
 * question, not for a report on the assistant's verification process.
 */
export const UNVERIFIED_CLAIM_NUDGE =
    "Check the values in your previous answer before it is sent. Per the Ground " +
    "Truth Rule you do not know a LIVE value (row counts, run status, sizes, " +
    "connection/item lists) that you did not just observe with a tool. Pick one:\n" +
    "1. If the value describes the user's live resources, re-derive it NOW with " +
    "run_script and report what the tool returned.\n" +
    "2. If it is documented or API behaviour rather than a live reading (a " +
    "default, a limit, a page size, a signature), it is NOT a live value — keep " +
    "your answer as it is and simply send it.\n" +
    "3. Only if it is live and you genuinely cannot run a tool, say \"I have not " +
    "verified this\" and drop the numbers.\n" +
    "Reply with the answer only. Do not apologise, do not say you failed to " +
    "verify, and do not narrate this check — the user must not see it.";

/**
 * Process/server nouns a lifecycle claim can be made about. Shared by both
 * lifecycle branches below so "the scheduler is no longer running" is caught in
 * either word order.
 */
const PROCESS_NOUN =
    "(airflow|standalone|server|webserver|scheduler|triggerer|process|instance|daemon|port|dag)";

/**
 * Keep only the parts of an answer that ASSERT something, by dropping question
 * sentences and interrogative complements ("check whether x", "see if x", "tell
 * you how many rows landed"). An assertion always precedes such a marker, so
 * cutting from the marker to the end of its sentence preserves real claims while
 * discarding capability, offer, and plan prose — which otherwise reads to the
 * patterns below as a live claim (enhancement 2026/07/29).
 */
function assertionsOnly(text: string): string {
    return text
        .split(/(?<=[.!?])\s+|\n+/)
        .filter(sentence => !sentence.trimEnd().endsWith("?"))
        .join("\n")
        .replace(/\b(?:whether|if|how many|how much)\b[^.!?\n]*/gi, " ");
}

/** Which heuristic branch flagged an answer, for guard telemetry. */
export type LiveDataClaimBranch = "numeric" | "landing" | "lifecycle";

/**
 * Does this finalized answer look like it asserts LIVE data — a number next to
 * a data-ish noun, a data-landing / emptiness claim about a destination, or a
 * process/server lifecycle claim ("I stopped Airflow", "the server is running")?
 * Returns the matching branch, or `undefined` when nothing is asserted.
 * Used ONLY when the agent produced no successful data-reading tool run this
 * request, to nudge it once to re-derive the value instead of asserting it
 * from memory.
 *
 * Intentionally conservative: only assertive text is examined (see
 * {@link assertionsOnly}), the numeric branch requires a digit adjacent to a
 * data noun, the landing branch requires a success/empty word co-occurring with
 * a load/destination word, and the lifecycle branch requires a state verb
 * co-occurring with a server/process noun — so plain conceptual or file-edit
 * answers (e.g. "successfully edited the file", "stopped editing") do NOT trip it.
 *
 * ⚠️ i18n REMINDER: the keyword patterns below are ENGLISH-ONLY. If/when the
 * assistant is localized to reply in other languages, this guard will fail
 * OPEN (it won't match the translated text, so no nudge fires and the
 * unverified answer is streamed as-is). When integrating i18n, either:
 *   - make these patterns locale-aware (translate the data-noun / success /
 *     empty keyword sets per supported locale), or
 *   - replace this lexical heuristic with a language-agnostic signal (e.g. the
 *     model self-tagging data claims, or the structured "verified facts" ledger
 *     from action #4 in docs/sdk_and_prompt_enhancement.md).
 */
export function classifyLiveDataClaim(text: string): LiveDataClaimBranch | undefined {
    if (!text || !text.trim()) return undefined;
    const t = assertionsOnly(text).toLowerCase();

    // `items?` excludes attributive use ("4 item types") — that names a schema,
    // not a count of live items.
    const dataNoun =
        "(rows?|records?|connections?|tables?|columns?|batch(?:es)?|bytes?|partitions?|dags?|runs?|workspaces?|items?(?!\\s+(?:types?|kinds?|categor)))";
    const number = "[\\d,.]*\\d[\\d,.]*";

    // (a) A number sitting next to a data noun: "541,909 rows", "3 connections".
    const numericDataClaim =
        new RegExp(`\\b${number}\\b[^.\\n]{0,30}\\b${dataNoun}\\b`).test(t)
        || new RegExp(`\\b${dataNoun}\\b[^.\\n]{0,30}\\b${number}\\b`).test(t);

    // (b) A data-landing / emptiness claim about a destination.
    const landingClaim =
        /\b(load(?:ed)?|insert(?:ed)?|copied|wrote|written|ingested)\b[^.\n]{0,40}\b(succeeded|success(?:fully)?|completed|finished|landed|done)\b/.test(t)
        || /\b(succeeded|success(?:fully)?|completed|finished|landed)\b[^.\n]{0,40}\b(load|insert|copy|rows?|records?|table|warehouse|lakehouse|blob)\b/.test(t)
        || /\b(no rows|0 rows|zero rows|is empty|are empty|table is empty|nothing was (?:loaded|written|inserted))\b/.test(t);

    // (c) A process/server LIFECYCLE claim the agent can only know by probing —
    //     "I stopped Airflow", "the server is no longer running", "killed it".
    //     Conservative: a state verb must co-occur with a server/process noun so
    //     generic "stopped editing" / "the loop finished" do NOT trip it.
    const lifecycleClaim =
        new RegExp(`\\b(started|stopped|killed|terminated|shut\\s*down|brought\\s*down|torn?\\s*down|restarted|now\\s+running|no\\s+longer\\s+running|is\\s+running|isn'?t\\s+running|not\\s+running)\\b[^.\\n]{0,40}\\b${PROCESS_NOUN}\\b`).test(t)
        || new RegExp(`\\b${PROCESS_NOUN}\\b[^.\\n]{0,40}\\b(started|stopped|killed|terminated|shut\\s*down|running|no\\s+longer\\s+running|not\\s+running)\\b`).test(t);

    if (numericDataClaim) return "numeric";
    if (landingClaim) return "landing";
    if (lifecycleClaim) return "lifecycle";
    return undefined;
}

/**
 * Reminder injected for the CURRENT turn when the user's message disputes or
 * distrusts a prior result (action #4 → guard #3 in
 * docs/sdk_and_prompt_enhancement.md, item "Make the disputed-result path
 * explicit"). Pushes the model toward running a tool instead of re-asserting.
 */
export const DISPUTE_REMINDER =
    "The user is disputing or distrusting a previous result. Do NOT re-assert, " +
    "argue, or explain why you think you were right. Immediately call run_script " +
    "to obtain the real, current value from the live resource, then report exactly " +
    "what the tool returned. If you genuinely cannot run a tool, say \"I have not " +
    "verified this\" explicitly. Lead with the result, not with an apology or a " +
    "post-mortem of the earlier answer.";

/**
 * Does the user's message look like a dispute / distrust cue — "you didn't run
 * it", "that's wrong", "check again", "literally run the query"? Used to bias
 * the current turn toward a tool call (so disputes force re-execution instead
 * of another remembered-value re-assertion).
 *
 * Substring matching (not regex) keeps it predictable and low on false
 * positives; a stray match only costs one extra reminder line in the prompt.
 *
 * ⚠️ i18n REMINDER: the cues below are ENGLISH-ONLY — see the note on
 * {@link looksLikeUnverifiedLiveDataClaim}. Translate the cue list per locale
 * when localizing.
 */
export function looksLikeUserDispute(text: string): boolean {
    if (!text || !text.trim()) return false;
    const t = text.toLowerCase();
    const cues = [
        "you did not", "you didn't", "you didnt",
        "you have not", "you haven't", "you havent", "you never",
        "did not run", "didn't run", "didnt run",
        "did not execute", "didn't execute", "didnt execute",
        "that's wrong", "thats wrong", "you're wrong", "youre wrong",
        "not correct", "incorrect", "is wrong",
        "check again", "run again", "try again", "verify again", "query again",
        "literally run", "actually run", "really run", "actually execute",
        "re-run", "rerun", "run the query", "run the script", "run it again",
        "no, you did", "no you did", "prove it", "are you sure",
        // Observed in real disputes (session 771a8b31) but previously unmatched —
        // keep aligned with phrases users actually type when distrusting a result.
        "nothing was run", "nothing were run", "nothing ran", "didn't actually",
        "did nothing", "you made it up", "made up", "fabricated", "bullshit",
        "stop lying", "you lied", "that's fake", "thats fake",
    ];
    return cues.some(c => t.includes(c));
}

