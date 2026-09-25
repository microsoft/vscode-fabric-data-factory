/**
 * Verified-facts ledger (action #4 in docs/sdk_and_prompt_enhancement.md).
 *
 * VS Code's chat history only preserves the *rendered markdown* of past turns,
 * so a number the agent observed via a tool in an earlier turn survives only as
 * prose — which the model then re-states as if it were freshly verified. This
 * ledger gives those values a structured, timestamped home that is re-injected
 * into the system prompt every turn, so the model can cite REAL recorded values
 * instead of re-asserting remembered ones (and the Ground Truth guard can tell
 * the difference).
 *
 * Recording protocol: a `run_script` (or resumed `await_handle`) emits markers
 * on its own output, one per line:
 *
 *     console.log("@fact OnlineRetail.total_rows = 541909");
 *
 * On a successful run the chat loop calls {@link recordFromOutput}, which parses
 * every `@fact <label> = <value>` marker and stores the latest value per label.
 *
 * Scope: instance-lifetime (per extension session), bounded, and cleared on
 * `/reset`. Each entry is timestamped so the model can judge staleness.
 */
export class VerifiedFactsLedger {
    /** label → latest { value, when }. Insertion order = recency (re-inserted on update). */
    private readonly facts = new Map<string, { value: string; when: string }>();

    /**
     * @param maxFacts      hard cap on distinct labels retained (oldest evicted).
     * @param surfaceLimit  how many (most-recent) facts to render into the prompt.
     */
    constructor(
        private readonly maxFacts = 40,
        private readonly surfaceLimit = 20,
    ) {}

    /** Number of distinct facts currently retained. */
    get size(): number {
        return this.facts.size;
    }

    /**
     * Parse `@fact <label> = <value>` markers from a successful run's output and
     * store the latest value per label. Returns how many markers were recorded.
     */
    recordFromOutput(output: string): number {
        if (!output) return 0;
        // `@fact` (case-insensitive), a label (up to 80 chars, no `=`/newline),
        // `=`, then the value (rest of the line, up to 200 chars).
        const re = /@fact\s+([^=\n]{1,80}?)\s*=\s*([^\n]{1,200})/gi;
        let count = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(output)) !== null) {
            const label = m[1].trim();
            const value = m[2].trim();
            if (!label || !value) continue;
            // Delete-then-set so the latest value wins AND the entry moves to the
            // end (most-recent) for eviction + surfacing order.
            this.facts.delete(label);
            this.facts.set(label, { value, when: new Date().toISOString() });
            count++;
        }
        while (this.facts.size > this.maxFacts) {
            const oldest = this.facts.keys().next().value;
            if (oldest === undefined) break;
            this.facts.delete(oldest);
        }
        return count;
    }

    /**
     * True if `text` appears to cite a currently-recorded fact value. Used by the
     * Ground Truth guard to avoid nudging the model when it legitimately echoes a
     * ledgered value. Comparison strips spaces/commas so "541,909" matches a
     * recorded "541909".
     */
    matches(text: string): boolean {
        if (this.facts.size === 0 || !text) return false;
        const norm = (s: string) => s.toLowerCase().replace(/[\s,]+/g, "");
        const tn = norm(text);
        for (const { value } of this.facts.values()) {
            const vn = norm(value);
            if (vn.length >= 2 && tn.includes(vn)) return true;
        }
        return false;
    }

    /**
     * Render a compact, most-recent-first block for the system prompt, or `""`
     * when the ledger is empty. Capped at `surfaceLimit` entries to bound tokens.
     */
    render(): string {
        if (this.facts.size === 0) return "";
        const entries = [...this.facts.entries()];
        const recent = entries.slice(-this.surfaceLimit).reverse();
        return recent
            .map(([label, f]) => `- ${label} = ${f.value}  (verified ${f.when})`)
            .join("\n");
    }

    /** Drop every recorded fact (called on `/reset`). */
    clear(): void {
        this.facts.clear();
    }
}
