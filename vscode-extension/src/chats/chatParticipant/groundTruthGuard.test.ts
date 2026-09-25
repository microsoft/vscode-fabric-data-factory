import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyLiveDataClaim, looksLikeUserDispute, UNVERIFIED_CLAIM_NUDGE } from "./groundTruthGuard.ts";

const trips = (text: string) => classifyLiveDataClaim(text) !== undefined;

/**
 * Answers that assert a live value the agent could only know by probing. These
 * MUST keep tripping the guard — they are the 2026-07-09 trust-collapse shapes
 * the guard exists to catch, and any relaxation that loses them is a regression.
 */
const CLAIMS = [
    "The load succeeded: 541,909 rows landed in the warehouse.",
    "Airflow is running on port 8080.",
    "The table is empty.",
    "I stopped the Airflow standalone process.",
    "You have 3 connections in that workspace.",
    "The copy completed successfully and wrote 12 records.",
    "I checked the warehouse — no rows were returned.",
    "The scheduler is no longer running.",
    "Your workspace has 7 items.",
    "The pipeline run finished, so the data landed in the lakehouse table.",
];

/**
 * Answers that describe a capability, offer, plan, or question. None of them
 * assert live state, so none may trip the guard — a misfire here costs the user
 * a bogus "Unverified" banner plus wasted nudge rounds (enhancement 2026/07/29).
 */
const NON_CLAIMS = [
    "Hi",
    "Hi!",
    "Hello! What would you like to do?",
    // The originating report: a greeting answered with a capability list, which
    // legitimately runs 0 tools and so satisfies every other guard precondition.
    "Hi! I'm the Data Integration assistant. I can:\n"
    + "1. List your Fabric connections\n"
    + "2. Run a script against a warehouse\n"
    + "3. Start or check whether a local Airflow is running\n"
    + "4. Create and edit pipeline JSON",
    "I can help you check whether a local Airflow is running.",
    "- Start or check if Airflow is running\n- Inspect DAGs",
    "I can tell you whether your local Airflow server is running.",
    "Hi! How can I help you today?",
    "I support 4 item types: Lakehouse, Warehouse, Pipeline, Notebook.",
    "I can list your connections and count rows in a table.",
    "Would you like me to run a script to see if the server is running?",
    "Next I will check whether the table is empty.",
    "I have not verified this - I did not run a tool this turn.",
    "Shall I check if the copy succeeded?",
    "Let me know if you want the row counts.",
    "I can tell you how many rows landed once you point me at a table.",
];

/**
 * Documented API behaviour that is lexically identical to a live reading, so it
 * DOES trip the guard. Narrowing the classifier to exclude these is rejected:
 * every candidate signal (inline code, a method name) also appears in the real
 * trust-collapse shape `\`OnlineRetail\` has 541,909 rows`, and losing a true
 * catch is the dangerous direction for this guard. These are made harmless by
 * the nudge copy instead — see the exit-2 assertions below.
 */
const DOCUMENTED_NOT_LIVE = [
    "`previewTable` returns the first 10 rows as formatted text.",
    "`listItems` returns up to 100 items per page.",
    "`loadJsonl` inserts records in batches of 1000.",
];

describe("classifyLiveDataClaim", () => {
    for (const text of CLAIMS) {
        it(`trips on a live-data claim: ${JSON.stringify(text)}`, () => {
            assert.equal(trips(text), true);
        });
    }

    for (const text of NON_CLAIMS) {
        it(`stays quiet on a non-claim: ${JSON.stringify(text)}`, () => {
            assert.equal(trips(text), false);
        });
    }

    for (const text of DOCUMENTED_NOT_LIVE) {
        it(`misfires on documented behaviour, by design: ${JSON.stringify(text)}`, () => {
            assert.equal(trips(text), true);
        });
    }

    it("still trips when an assertion precedes a conditional clause", () => {
        assert.equal(trips("Airflow is running. Let me know if you want the logs."), true);
    });

    it("reports the branch that matched", () => {
        assert.equal(classifyLiveDataClaim("You have 3 connections."), "numeric");
        assert.equal(classifyLiveDataClaim("The table is empty."), "landing");
        assert.equal(classifyLiveDataClaim("Airflow is running on port 8080."), "lifecycle");
    });

    it("ignores empty and whitespace input", () => {
        assert.equal(trips(""), false);
        assert.equal(trips("   \n  "), false);
    });
});

describe("looksLikeUserDispute", () => {
    it("matches distrust cues", () => {
        assert.equal(looksLikeUserDispute("no you did not change it at all"), true);
        assert.equal(looksLikeUserDispute("are you sure?"), true);
    });

    it("does not match a plain confirmation", () => {
        assert.equal(looksLikeUserDispute("yes"), false);
    });
});

/**
 * The nudge is the only thing standing between a misfire and a turn where the
 * model apologises for not verifying a documented default. Both properties are
 * load-bearing, so both are pinned.
 */
describe("UNVERIFIED_CLAIM_NUDGE", () => {
    it("offers the documented-behaviour exit, so a misfire has a correct answer", () => {
        assert.match(UNVERIFIED_CLAIM_NUDGE, /documented or API behaviour/i);
        assert.match(UNVERIFIED_CLAIM_NUDGE, /keep your answer as it is/i);
    });

    it("forbids apologising and narrating the check", () => {
        assert.match(UNVERIFIED_CLAIM_NUDGE, /do not apologise/i);
        assert.match(UNVERIFIED_CLAIM_NUDGE, /do not narrate this check/i);
    });

    it("keeps the live-value re-derivation as the first option", () => {
        const derive = UNVERIFIED_CLAIM_NUDGE.indexOf("re-derive it NOW");
        const disclaim = UNVERIFIED_CLAIM_NUDGE.indexOf("I have not verified this");
        assert.ok(derive > -1 && disclaim > derive, "running a tool must be offered before disclaiming");
    });
});
