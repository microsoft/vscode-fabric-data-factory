import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFabricAccess, fabricAccessAdvice } from "./fabric_access_error.ts";
import { classifyNetworkError } from "./network_error.ts";

/** Build an addon-style error: human summary, marker, then the JSON envelope. */
function addonError(summary: string, fields: Record<string, unknown>, kind = "Auth"): Error {
    const envelope = JSON.stringify({ kind, summary, chain: [], fields });
    return new Error(`${summary}\n---<DIAGNOSTIC>---\n${envelope}`);
}

/** Verbatim 401 body observed on 2026-07-30 and 2026-08-04 (13 occurrences). */
const NOT_LICENSED_BODY =
    '{"requestId":"d3ee22db-b775-4d59-aef3-73d9ddebf000","errorCode":"UserNotLicensed",' +
    '"message":"User is not licensed","isRetriable":false}';

test("a licensing 401 is recognized from the structured errorCode", () => {
    const err = addonError(`HTTP 401: ${NOT_LICENSED_BODY}`, {
        status: 401,
        body: NOT_LICENSED_BODY,
    });
    assert.equal(classifyFabricAccess(err), "license");
    assert.match(fabricAccessAdvice("license"), /isRetriable:false/);
});

test("the transport classifier cannot make this distinction", () => {
    // Both a licensing 401 and a sign-in 401 stringify to text containing "401",
    // so the message path collapses them — which is why the two layers are split.
    const err = addonError(`HTTP 401: ${NOT_LICENSED_BODY}`, { status: 401, body: NOT_LICENSED_BODY });
    assert.equal(classifyNetworkError(err.message), "auth");
    assert.equal(classifyNetworkError("HTTP 401: invalid token"), "auth");
});

test("an unmapped errorCode stays unclassified", () => {
    // ItemHasProtectedLabel is the highest-volume 403 in telemetry (97) and is a
    // sensitivity-label block, not an access problem: classifying it as a
    // permission failure would hand the user useless admin-escalation advice.
    const body = '{"errorCode":"ItemHasProtectedLabel","message":"blocked"}';
    const err = addonError(`HTTP 403: ${body}`, { status: 403, body });
    assert.equal(classifyFabricAccess(err), undefined);
});

test("errors with no diagnostic envelope are left to the transport classifier", () => {
    assert.equal(classifyFabricAccess(new Error("ECONNREFUSED")), undefined);
    assert.equal(classifyFabricAccess("self-signed certificate"), undefined);
    assert.equal(classifyFabricAccess(undefined), undefined);
});

test("a malformed envelope never throws", () => {
    assert.equal(classifyFabricAccess(new Error("x\n---<DIAGNOSTIC>---\nnot json")), undefined);
    assert.equal(classifyFabricAccess(addonError("HTTP 401: x", { body: "{unparseable" })), undefined);
    assert.equal(classifyFabricAccess(addonError("HTTP 401: x", { body: 401 })), undefined);
});
