/**
 * Classify a Fabric **service** rejection by the `errorCode` the API returns —
 * a different layer from {@link "./network_error"}, which classifies the
 * *transport* (proxy / TLS / DNS / timeout) and only ever sees a flattened
 * message string.
 *
 * The two are deliberately separate and neither wraps the other. A caller that
 * needs both asks each in turn, so the precedence is visible at the call site:
 *
 * ```ts
 * const access = classifyFabricAccess(err);          // service said why
 * const kind = access ?? classifyNetworkError(msg);  // otherwise, transport
 * ```
 *
 * Why this cannot live in the message matcher: a licensing 401 and a plain
 * sign-in 401 are both HTTP 401 and both stringify to text containing "401",
 * so no substring rule can separate them. The addon already carries the answer
 * structurally in its diagnostic envelope (`fields.body` → `errorCode`), which
 * is what this module reads.
 */

// Relative, with extension, so this module stays resolvable by `node --test`
// (the `@/` alias is a bundler/tsc mapping node does not honour).
import {parseDiagnostic} from "./diagnostic.ts";

/**
 * A Fabric access failure specific enough to give the user a real next step.
 * Only codes with observed evidence are listed — an unrecognized code stays
 * unclassified rather than being guessed at.
 */
export type FabricAccessKind = "license";

/** Observed Fabric `errorCode` values, lower-cased, mapped to their kind. */
const ERROR_CODE_KINDS: Record<string, FabricAccessKind> = {
    usernotlicensed: "license",
};

/** The Fabric `errorCode` carried in the addon's diagnostic envelope, if any. */
function fabricErrorCode(err: unknown): string | undefined {
    const body = parseDiagnostic(err)?.fields.body;
    if (typeof body !== "string") {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(body);
        const code = (parsed as {errorCode?: unknown} | null)?.errorCode;
        return typeof code === "string" ? code : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The access failure Fabric reported, or `undefined` when this is not a
 * recognized access rejection — in which case the caller should fall back to
 * transport classification.
 *
 * Returning `undefined` for unknown codes is deliberate: `ItemHasProtectedLabel`
 * is the highest-volume 403 in telemetry and is a sensitivity-label block, not
 * an access problem. Treating every 403 as "permission" would hand the user
 * admin-escalation advice for something only a label change fixes.
 */
export function classifyFabricAccess(err: unknown): FabricAccessKind | undefined {
    const code = fabricErrorCode(err);
    return code ? ERROR_CODE_KINDS[code.toLowerCase()] : undefined;
}

/** One actionable sentence, shared so every caller says the same thing. */
export function fabricAccessAdvice(kind: FabricAccessKind): string {
    switch (kind) {
        case "license":
            return (
                "Fabric rejected this account as UserNotLicensed. Check that it has a Fabric " +
                "or Power BI license and access to a capacity; if those are managed centrally, " +
                "ask your tenant or capacity admin. Signing in again will not change this " +
                "response — Fabric returned isRetriable:false."
            );
    }
}
