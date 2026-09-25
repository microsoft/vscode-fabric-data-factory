/**
 * Multi-step interactive prompt helpers for the `@di` chat participant.
 *
 * Unlike the one-shot `showInputBox` / `showQuickPick` wrappers, these use
 * the lower-level `createInputBox` / `createQuickPick` so we can support:
 *  - A **Back** button (`QuickInputButtons.Back`) for wizard-style navigation,
 *    letting the user move backward through a form and revise earlier answers.
 *  - **Custom answers** in a quick-pick — the user can type a value that isn't
 *    in the option list and pick it (single-select only).
 *
 * {@link executeAskUserForm} chains these into a single guided form; the step
 * helpers are also reused by `ask_user_choice` (single-select, no Back button).
 */

import * as vscode from "vscode";
import { log } from "@/utils/channel_log";

/** Outcome of a single wizard step. */
export type StepOutcome =
    | { kind: "value"; value: string | string[] }
    | { kind: "back" }
    | { kind: "cancel" };

/** Options for {@link showInputStep}. */
export interface InputStepOptions {
    question: string;
    placeholder?: string;
    value?: string;
    password?: boolean;
    /** 1-based step index (shows "(n/total)" in the title bar). */
    step?: number;
    totalSteps?: number;
    /** Render a Back button (multi-step forms only). */
    canGoBack?: boolean;
    /** Pre-fill value when navigating back into this step. */
    prior?: string;
}

/** Show a text input box as one step of a form. */
export function showInputStep(
    opts: InputStepOptions,
    token?: vscode.CancellationToken,
): Promise<StepOutcome> {
    return new Promise<StepOutcome>((resolve) => {
        const box = vscode.window.createInputBox();
        box.title = opts.question;
        box.step = opts.step;
        box.totalSteps = opts.totalSteps;
        box.prompt = opts.question;
        box.placeholder = opts.placeholder;
        box.value = opts.prior ?? opts.value ?? "";
        box.password = opts.password === true;
        box.ignoreFocusOut = true;
        box.buttons = opts.canGoBack ? [vscode.QuickInputButtons.Back] : [];

        const disposables: vscode.Disposable[] = [];
        const finish = (o: StepOutcome) => {
            for (const d of disposables) d.dispose();
            box.dispose();
            resolve(o);
        };

        disposables.push(
            box.onDidTriggerButton((b) => {
                if (b === vscode.QuickInputButtons.Back) finish({ kind: "back" });
            }),
            box.onDidAccept(() => finish({ kind: "value", value: box.value })),
            box.onDidHide(() => finish({ kind: "cancel" })),
        );
        if (token) {
            disposables.push(token.onCancellationRequested(() => finish({ kind: "cancel" })));
        }
        box.show();
    });
}

/** Options for {@link showChoiceStep}. */
export interface ChoiceStepOptions {
    question: string;
    options: string[];
    canSelectMany?: boolean;
    /** Let the user type a value not in the list (single-select only). */
    allowCustom?: boolean;
    step?: number;
    totalSteps?: number;
    canGoBack?: boolean;
    /** Pre-select (or, for a custom answer, pre-fill) when navigating back. */
    prior?: string | string[];
}

/** Show a quick-pick as one step of a form, optionally with a custom-answer affordance. */
export function showChoiceStep(
    opts: ChoiceStepOptions,
    token?: vscode.CancellationToken,
): Promise<StepOutcome> {
    return new Promise<StepOutcome>((resolve) => {
        const qp = vscode.window.createQuickPick();
        const multi = opts.canSelectMany === true;
        const allowCustom = opts.allowCustom === true && !multi;

        qp.title = opts.question;
        qp.step = opts.step;
        qp.totalSteps = opts.totalSteps;
        qp.placeholder = allowCustom
            ? "Pick an option — or type your own answer and press Enter"
            : opts.question;
        qp.canSelectMany = multi;
        qp.ignoreFocusOut = true;
        qp.matchOnDescription = true;

        const buttons: vscode.QuickInputButton[] = opts.canGoBack ? [vscode.QuickInputButtons.Back] : [];
        qp.buttons = buttons;

        const baseItems: vscode.QuickPickItem[] = opts.options.map((label) => ({ label }));
        qp.items = baseItems;

        // Restore prior selection / custom text when navigating back into this step.
        if (opts.prior !== undefined) {
            if (multi && Array.isArray(opts.prior)) {
                qp.selectedItems = baseItems.filter((i) => (opts.prior as string[]).includes(i.label));
            } else if (!multi && typeof opts.prior === "string") {
                const match = baseItems.find((i) => i.label === opts.prior);
                if (match) qp.activeItems = [match];
                else if (allowCustom) qp.value = opts.prior;
            }
        }

        const disposables: vscode.Disposable[] = [];
        const finish = (o: StepOutcome) => {
            for (const d of disposables) d.dispose();
            qp.dispose();
            resolve(o);
        };

        // Custom-answer affordance: surface a synthetic "use this" item that
        // mirrors whatever the user is typing (unless it matches an option).
        if (allowCustom) {
            disposables.push(qp.onDidChangeValue((val) => {
                const typed = val.trim();
                if (!typed) { qp.items = baseItems; return; }
                const exists = opts.options.some((o) => o.toLowerCase() === typed.toLowerCase());
                qp.items = exists
                    ? baseItems
                    : [{ label: typed, description: "Use this custom answer", alwaysShow: true }, ...baseItems];
            }));
        }

        disposables.push(
            qp.onDidTriggerButton((b) => {
                if (b === vscode.QuickInputButtons.Back) finish({ kind: "back" });
            }),
            qp.onDidAccept(() => {
                if (multi) {
                    finish({ kind: "value", value: qp.selectedItems.map((i) => i.label) });
                    return;
                }
                const picked = qp.selectedItems[0] ?? qp.activeItems[0];
                const value = picked?.label ?? qp.value.trim();
                if (!value) return; // ignore an empty accept
                finish({ kind: "value", value });
            }),
            qp.onDidHide(() => finish({ kind: "cancel" })),
        );
        if (token) {
            disposables.push(token.onCancellationRequested(() => finish({ kind: "cancel" })));
        }
        qp.show();
    });
}

/**
 * `ask_user_form` — run a guided, multi-step form (wizard) with Back/Next
 * navigation. Each step is a text input or a choice; the user can move
 * backward to revise earlier answers (prior answers are pre-filled on
 * revisit). Returns JSON `{ answers: { <key>: value, … } }`, or
 * `{ cancelled: true }` if the user dismissed the form.
 *
 * Secret hygiene: a password input step is stored in VS Code SecretStorage
 * under its `secretKey` (when given) and recorded in `answers` only as
 * `{ provided: true, secretKey }` — the raw value is never returned.
 */
export async function executeAskUserForm(
    input: Record<string, unknown>,
    token: vscode.CancellationToken,
    secrets: vscode.SecretStorage,
): Promise<string> {
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    const steps = rawSteps.filter((s): s is Record<string, unknown> => !!s && typeof s === "object");
    if (steps.length === 0) {
        log("[di-chat] ask_user_form: no steps provided");
        return JSON.stringify({ error: "No steps were provided for the form." });
    }
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;

    const answers: Record<string, unknown> = {};
    // Remembers each step's last value so navigating Back re-fills it.
    const priorByIndex: Array<string | string[] | undefined> = new Array(steps.length).fill(undefined);

    let i = 0;
    // Measured across the whole form: a user who never finds step 1 is the case
    // this exists to catch, and per-step timing would hide it in an average.
    const askedAt = Date.now();
    while (i < steps.length) {
        if (token.isCancellationRequested) return JSON.stringify({ cancelled: true });

        const step = steps[i];
        const key = String(step.key ?? `field_${i + 1}`);
        const kind = step.kind === "choice" ? "choice" : "input";
        const rawQuestion = String(step.question ?? "").trim() || `Step ${i + 1}`;
        const question = title ? `${title} — ${rawQuestion}` : rawQuestion;
        const canGoBack = i > 0;

        let outcome: StepOutcome;
        if (kind === "choice") {
            const options = (Array.isArray(step.options) ? step.options : [])
                .map((o) => (typeof o === "string" ? o : String((o as { label?: unknown })?.label ?? "")))
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            if (options.length === 0) {
                log(`[di-chat] ask_user_form: choice step '${key}' has no options`);
                return JSON.stringify({ error: `Form step '${key}' is a choice but has no options.` });
            }
            outcome = await showChoiceStep({
                question,
                options,
                canSelectMany: step.canSelectMany === true,
                allowCustom: step.allowCustom === true,
                step: i + 1,
                totalSteps: steps.length,
                canGoBack,
                prior: priorByIndex[i],
            }, token);
        } else {
            const prior = priorByIndex[i];
            outcome = await showInputStep({
                question,
                placeholder: typeof step.placeholder === "string" ? step.placeholder : undefined,
                value: typeof step.value === "string" ? step.value : undefined,
                password: step.password === true,
                step: i + 1,
                totalSteps: steps.length,
                canGoBack,
                prior: typeof prior === "string" ? prior : undefined,
            }, token);
        }

        if (outcome.kind === "cancel") {
            log(`[di-chat] ask_user_form: outcome=cancelled waitedMs=${Date.now() - askedAt} atStep=${i + 1}/${steps.length}`);
            return JSON.stringify({ cancelled: true });
        }
        if (outcome.kind === "back") {
            i = Math.max(0, i - 1);
            continue;
        }

        priorByIndex[i] = outcome.value;

        // Secret hygiene: never round-trip a password through the model.
        if (kind === "input" && step.password === true) {
            const secretKey = typeof step.secretKey === "string" ? step.secretKey.trim() : "";
            if (secretKey && typeof outcome.value === "string") {
                await secrets.store(secretKey, outcome.value);
                answers[key] = { provided: true, secretKey };
            } else {
                answers[key] = { provided: true };
            }
        } else {
            answers[key] = outcome.value;
        }
        i++;
    }

    log(`[di-chat] ask_user_form: outcome=answered waitedMs=${Date.now() - askedAt} collected ${Object.keys(answers).length} answer(s)`);
    return JSON.stringify({ answers });
}
