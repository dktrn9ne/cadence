// Mount-recovery assessment — pure functions (PR 04 wave 4).
//
// The dashboard owns the I/O (storage restore, ledger lookups, state commits);
// this module owns the recovery RULES, testable in isolation:
//
//   restore -> reconcile -> classify -> assess missed -> surface -> resume
//
// Recovery never dispatches. The only submit path stays the guarded
// dispatcher; recovery classifies and surfaces, and the plan resumes through
// the normal scheduling and approval flows.

// What mount reconciliation must do with a persisted attempt. The persisted
// statuses map onto exactly three actions:
//
//   - "reconcile"     — submitted | unresolved: a hash exists, so the ledger
//                       can classify it by lookup. This is the ONLY exit from
//                       an unknown outcome (never a timer, never a retry).
//   - "record-failed" — awaiting_signature: the wallet prompt died with the
//                       previous session. Nothing was submitted, so there is
//                       no hash to reconcile — a failed attempt is recorded
//                       (never an advance, never an auto-retry).
//   - "none"          — validated_success | validated_failure: terminal, and
//                       unrecognized statuses too — those keep blocking via
//                       the attempt guard (fail closed), so recovery leaves
//                       them exactly as stored.
export function mountAttemptAction(attempt) {
  switch (attempt?.status) {
    case "submitted":
    case "unresolved":
      return "reconcile";
    case "awaiting_signature":
      return "record-failed";
    default:
      return "none";
  }
}

// How many installments came due on or after `nextRunAt` and before `now`.
// Windows past the remaining installment budget are dropped — clock drift can
// never drive a plan past its total. Anything not overdue (future or unset
// nextRunAt), paused, or complete counts zero.
export function countMissedWindows({ nextRunAt, frequencyMs, remaining, now }) {
  if (typeof nextRunAt !== "number" || !Number.isFinite(nextRunAt)) return 0;
  if (typeof frequencyMs !== "number" || !Number.isFinite(frequencyMs) || frequencyMs <= 0) return 0;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) return 0;
  if (nextRunAt > now) return 0;
  const overdue = Math.floor((now - nextRunAt) / frequencyMs) + 1;
  return Math.max(0, Math.min(overdue, remaining));
}

// Neutral display/schedule defaults for fields a stored plan is allowed to
// miss (envelopes written before the schedule fields joined the persisted
// allowlist). "0" is the honest default for an unknown pay rate — the restored
// plan renders its $0 schedule rather than inventing one; the release note
// covers the honest reset for pre-PR sessions.
const RESTORE_DEFAULTS = {
  name: "",
  role: "",
  email: "",
  payMode: "weekly",
  weeklyPay: "0",
  hourlyPay: "0",
  hoursPerWeek: "0",
  frequency: "minute",
};

// Map persisted plans onto the dashboard's plan shape. Storage emits the
// spec's `destination` key; the editor and payment paths read `address`.
// Restored plans are stamped `recovered: true` so the card can show the
// recovered-from-last-session banner; session-only fields are never persisted
// (the storage allowlist strips them on write).
export function hydrateRestoredPlans(plans) {
  if (!Array.isArray(plans)) return [];
  return plans
    .filter((plan) => plan && typeof plan === "object" && typeof plan.id === "string" && plan.id)
    .map((plan) => ({
      ...RESTORE_DEFAULTS,
      ...plan,
      address: plan.destination ?? plan.address ?? "",
      recovered: true,
    }));
}
