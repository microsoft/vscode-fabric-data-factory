import type { AccountInfoJs } from "data-integration";
import { tryGetDIContext } from "@/services/di-context";

/**
 * Microsoft Corp Entra tenant id (a public, well-known identifier).
 * Used to gate the "Report Bug" toast action: the internal `msdata`
 * ADO project only accepts work items from Microsoft FTEs, so we
 * shouldn't advertise the action to external customers.
 */
const MICROSOFT_TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";

/**
 * Cached *positive* Microsoft-tenant lookup. Once we've confirmed the
 * user is signed in to the Microsoft tenant we keep the snapshot so
 * subsequent error toasts don't pay the napi round-trip. We never
 * cache a negative result — the user might sign in mid-session, and
 * the cost of re-checking on each error in the unsigned state is one
 * cheap addon call that resolves to `null`.
 */
let cachedMicrosoftAccount: AccountInfoJs | undefined;

/**
 * Resolve the signed-in Microsoft account, or `undefined` if the user
 * isn't signed in to the Microsoft tenant (or the DI context hasn't
 * been created yet). Never throws — the bug-report gating must not
 * break the error-reporting path.
 */
export async function resolveMicrosoftAccount(): Promise<AccountInfoJs | undefined> {
  if (cachedMicrosoftAccount) return cachedMicrosoftAccount;
  try {
    const ctx = tryGetDIContext();
    if (!ctx) return undefined;
    const info = await ctx.auth.getAccountInfo();
    if (!info?.tenantId) return undefined;
    if (info.tenantId.toLowerCase() !== MICROSOFT_TENANT_ID) return undefined;
    cachedMicrosoftAccount = info;
    return info;
  } catch {
    return undefined;
  }
}

/**
 * Returns `true` when the user is signed in to the Microsoft Corp
 * tenant. Used by the chat participant to gate the "Open ADO bug
 * report" button — the target ADO project is internal-only, so we
 * don't advertise the link to external customers.
 */
export async function isMicrosoftAccount(): Promise<boolean> {
  return !!(await resolveMicrosoftAccount());
}
