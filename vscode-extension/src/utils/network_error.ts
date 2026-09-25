/**
 * Classify a *network*-layer failure reaching Microsoft Fabric — as distinct
 * from an auth failure. This lets us tell a genuine "token works but the
 * network is blocked" case (corporate proxy / TLS interception / firewall /
 * DNS — the S7 scenario) apart from a 401/403 or a "not signed in", so the user
 * can be pointed at the likely cause instead of a generic error.
 */

export type NetworkErrorKind =
    | "tls"
    | "proxy"
    | "connection-refused"
    | "dns"
    | "timeout"
    | "auth"
    | "other";

/** Best-effort classification of an error message from the Fabric HTTP layer. */
export function classifyNetworkError(message: string): NetworkErrorKind {
    const m = message.toLowerCase();

    // Proxy markers first: "forbidden by proxy" / "403 … proxy" / a 407 are
    // connectivity problems, so classify them before the generic auth match
    // below (which would otherwise swallow the "forbidden"/"403" text and
    // suppress the S7 warning).
    if (m.includes("proxy") || m.includes("407")) {
        return "proxy";
    }

    // Auth next: a 401/403 (without a proxy marker) is not a connectivity issue.
    if (
        m.includes("401") ||
        m.includes("403") ||
        m.includes("unauthorized") ||
        m.includes("forbidden") ||
        m.includes("invalidauthenticationtoken")
    ) {
        return "auth";
    }
    if (
        m.includes("certificate") ||
        m.includes("self-signed") ||
        m.includes("self signed") ||
        m.includes("unable to get local issuer") ||
        m.includes("tls") ||
        m.includes("ssl") ||
        m.includes("cert")
    ) {
        return "tls";
    }
    if (m.includes("econnrefused") || m.includes("connection refused")) {
        return "connection-refused";
    }
    if (
        m.includes("enotfound") ||
        m.includes("eai_again") ||
        m.includes("failed to lookup") ||
        m.includes("name resolution") ||
        m.includes("dns")
    ) {
        return "dns";
    }
    if (m.includes("etimedout") || m.includes("timed out") || m.includes("timeout")) {
        return "timeout";
    }
    return "other";
}

/**
 * Whether a kind indicates the network path to Fabric is blocked/broken (a
 * proxy / TLS / firewall / DNS problem) rather than an auth or unclassified
 * error — i.e. the S7 signature that warrants a targeted "can't reach Fabric"
 * message.
 */
export function isLikelyBlocked(kind: NetworkErrorKind): boolean {
    return (
        kind === "tls" ||
        kind === "proxy" ||
        kind === "connection-refused" ||
        kind === "dns" ||
        kind === "timeout"
    );
}
