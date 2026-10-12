// Durable plan + attempt state for the scheduler (PR 04).
//
// The persisted shape is a CLOSED ALLOWLIST — plan identity, payer/destination
// addresses, progress, schedule state, and the per-installment attempt ledger.
// The writer serializes an allowlisted shape, never the caller's object, so
// secrets (mnemonic, seed, private key, signed blob) cannot leak by
// construction. This is deliberately stronger than the dashboard's
// safeLogPayload redaction (src/StreamPayDashboard.jsx), which scrubs by key
// name after the fact: an allowlist cannot forget a new secret-shaped field.

const STORAGE_KEY = "cadence-plans-v1"; // versioned; bump = migrate, never reinterpret
const CURRENT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

// --- allowlist coercion -----------------------------------------------------

const asString = (value) => (typeof value === "string" ? value : "");
const asStamp = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asHash = (value) => (typeof value === "string" && value ? value : null);
// Counts accept numeric strings (dashboard inputs are strings everywhere);
// anything that is not a non-negative safe integer reads as 0.
const asCount = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
// A sequence number keys the installment; it must be exact, not coerced —
// garbage cannot be silently folded onto installment :0.
const asSequence = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

const installmentKey = (planId, sequence) => `${planId}:${sequence}`;

// Attempts are numbered per installment: every retry writes its OWN record
// (`${planId}:${sequence}#${attemptNo}`), so attempt history survives — a
// retry never overwrites the evidence of the attempt before it (audit
// art_FIvT05e6, violation 4). Legacy envelopes predate attemptNo; they
// re-key onto #1.
const asAttemptNo = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
};

export const attemptKey = (planId, sequence, attemptNo) =>
  `${installmentKey(planId, sequence)}#${asAttemptNo(attemptNo)}`;

// Returns an allowlisted attempt record, or null when the entry cannot be
// keyed (no valid sequence) — corrupt entries are dropped, never repaired.
// payer/destination/amount carry the attempt's payment identity so a ledger
// lookup can prove a transaction IS this attempt's payment before its
// verdict may classify anything (audit violation 1).
function sanitizeAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return null;
  const sequence = asSequence(attempt.sequence);
  if (sequence === null) return null;
  return {
    sequence,
    status: typeof attempt.status === "string" ? attempt.status : "scheduled",
    hash: asHash(attempt.hash),
    submittedAt: asStamp(attempt.submittedAt),
    amount: asString(attempt.amount),
    payer: asString(attempt.payer),
    destination: asString(attempt.destination),
    attemptNo: asAttemptNo(attempt.attemptNo),
  };
}

// Re-derives every attempt key from its own sequence + attempt number, so the
// map is always keyed by the deterministic per-attempt id whatever key the
// (possibly drifted) stored entry arrived under.
function sanitizeAttempts(attempts, planId) {
  if (!attempts || typeof attempts !== "object") return {};
  const next = {};
  for (const entry of Object.values(attempts)) {
    const attempt = sanitizeAttempt(entry);
    if (!attempt) continue;
    next[attemptKey(planId, attempt.sequence, attempt.attemptNo)] = attempt;
  }
  return next;
}

// The newest attempt for an installment — the record the dispatch guard and
// the missed-window assessment must read. Earlier attempts remain in storage
// as history and are never consulted for the guard.
export function latestAttemptFor(plan, sequence) {
  const wanted = Number(sequence);
  let latest = null;
  for (const entry of Object.values(plan?.attempts || {})) {
    if (Number(entry?.sequence) !== wanted) continue;
    if (!latest || Number(entry.attemptNo) > Number(latest.attemptNo)) latest = entry;
  }
  return latest;
}

// Public schedule/display fields. Without these a restored plan cannot render
// its meter ("2 / total" needs the schedule) or resume its cadence — they are
// the spec envelope's "schedule state". All public data; secrets stay
// excluded by the closed allowlist.
const PLAN_FIELD_KEYS = [
  "name",
  "role",
  "email",
  "payMode",
  "weeklyPay",
  "hourlyPay",
  "hoursPerWeek",
  "frequency",
];

// Returns an allowlisted plan, or null when the plan has no identity —
// without an id it cannot be keyed or restored, so it does not persist.
function sanitizePlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  const id = asString(plan.id);
  if (!id) return null;
  return {
    id,
    payer: asString(plan.payer),
    // The dashboard's plan objects carry the destination address as `address`
    // (the editor form field); it persists under the spec envelope's
    // `destination` key. Accept both on input so the storage layer stays
    // decoupled from the dashboard's field name.
    destination: asString(plan.destination ?? plan.address),
    paidCount: asCount(plan.paidCount),
    nextRunAt: asStamp(plan.nextRunAt),
    active: plan.active === true,
    ...Object.fromEntries(PLAN_FIELD_KEYS.map((key) => [key, asString(plan[key])])),
    attempts: sanitizeAttempts(plan.attempts, id),
  };
}

function buildEnvelope(plans) {
  return {
    version: CURRENT_VERSION,
    savedAt: Date.now(),
    plans: (Array.isArray(plans) ? plans : []).map(sanitizePlan).filter(Boolean),
  };
}

// --- storage I/O ------------------------------------------------------------

let pendingEnvelope = null;
let pendingTimer = null;

function writeEnvelope(envelope) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch (err) {
    // Quota/private-mode failures must not crash the payment flow, but the
    // failure stays visible — a silent drop here would look exactly like a
    // lost attempt record.
    console.warn("[planState] failed to persist plan state:", err);
    return false;
  }
}

function readEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  if (parsed.version !== CURRENT_VERSION) {
    // A version bump means migrate forward; an unknown version means the
    // bytes were written by newer/other code — start from defaults rather
    // than reinterpret what we do not understand.
    console.warn("[planState] unknown storage version, using defaults:", parsed.version);
    return [];
  }
  if (!Array.isArray(parsed.plans)) return [];
  return parsed.plans.map(sanitizePlan).filter(Boolean);
}

// --- public API -------------------------------------------------------------

// Restores the persisted plans array. Malformed JSON, unknown versions, and
// unavailable storage all resolve to safe defaults — this runs at mount and
// must never throw.
export function loadPlans() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return readEnvelope(JSON.parse(raw));
  } catch (err) {
    console.warn("[planState] could not load plan state, using defaults:", err);
    return [];
  }
}

// Full-replace save, debounced to coalesce bursts of UI edits into one write.
// Callers must pass the complete plans array they want durable; anything that
// is not an array is a caller bug and is ignored rather than persisted as an
// empty envelope (which would wipe stored state).
export function savePlans(plans) {
  if (!Array.isArray(plans)) {
    console.warn("[planState] savePlans expects an array of plans, got:", typeof plans);
    return;
  }
  pendingEnvelope = buildEnvelope(plans);
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const envelope = pendingEnvelope;
    pendingEnvelope = null;
    if (envelope) writeEnvelope(envelope);
  }, SAVE_DEBOUNCE_MS);
}

// Forces any pending debounced save to land immediately (e.g. on unmount or
// beforeunload). No-op when nothing is pending.
export function flushPlans() {
  if (pendingTimer === null) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  const envelope = pendingEnvelope;
  pendingEnvelope = null;
  if (envelope) writeEnvelope(envelope);
}

// Pure update: upserts the allowlisted attempt under its per-attempt key
// (`${planId}:${sequence}#${attemptNo}`). Returns a new plans array, or the
// SAME reference when nothing changed (unknown plan, invalid attempt) so
// callers can detect the no-op without a deep compare. Never throws.
export function applyAttempt(plans, planId, attempt) {
  if (!Array.isArray(plans) || plans.length === 0) return plans;
  const sanitized = sanitizeAttempt(attempt);
  if (!sanitized || typeof planId !== "string" || !planId) return plans;
  const index = plans.findIndex((plan) => plan && plan.id === planId);
  if (index === -1) return plans;
  const current = plans[index];
  const key = attemptKey(planId, sanitized.sequence, sanitized.attemptNo);
  return [
    ...plans.slice(0, index),
    { ...current, attempts: { ...(current.attempts || {}), [key]: sanitized } },
    ...plans.slice(index + 1),
  ];
}

// Pure update + immediate persist. Attempts are the durability-critical
// records — a submitted hash must survive the reload it is supposed to be
// reconciled after — so they bypass the savePlans debounce window. Any
// pending debounced save is cancelled: the immediate write persists the
// newest full envelope, so the pending one is stale the moment this lands.
// Returns { plans, persisted }: persisted is false when the record did NOT
// land durably (no-op, or the storage write failed). The dispatcher treats a
// false as fail-closed — an untracked payment is how double-pays happen
// (audit violation 3).
export function recordAttempt(plans, planId, attempt) {
  const next = applyAttempt(plans, planId, attempt);
  if (next === plans) return { plans, persisted: false };
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingEnvelope = null;
  }
  const persisted = writeEnvelope(buildEnvelope(next));
  return { plans: next, persisted };
}
