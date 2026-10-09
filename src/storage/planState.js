// Durable plan + attempt state for the scheduler (PR 04).
//
// The persisted shape is a CLOSED ALLOWLIST — plan identity, payer/destination
// addresses, progress, schedule state, and the per-installment attempt ledger.
// The writer serializes an allowlisted shape, never the caller's object, so
// secrets (mnemonic, seed, private key, signed blob) cannot leak by
// construction. This is deliberately stronger than the dashboard's
// safeLogPayload redaction (src/StreamPayDashboard.jsx), which scrubs by key
// name after the fact: an allowlist cannot forget a new secret-shaped field.

import { canonicalJson } from "./paymentsStore.js";

const STORAGE_KEY = "cadence-plans-v1"; // versioned; bump = migrate, never reinterpret
const CURRENT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;
// Quarantine key mirrors the record document's convention: a corrupt or
// unrecognized payload is copied aside for recovery, never reinterpreted.
const QUARANTINE_KEY = `${STORAGE_KEY}.quarantine`;

// --- load/save status channel -----------------------------------------------
//
// planState loads synchronously (the dashboard's useState initializer), so
// load-time failures cannot throw to a React boundary — they publish a status
// the durable-payments hook folds into the storage banner and the dispatch
// gate. States mirror the banner's known tones (see StorageBanner): ready,
// corrupt, unknown_version, write_failed, invalid_rows.

const STATUS_STATES = Object.freeze(["ready", "corrupt", "unknown_version", "write_failed", "invalid_rows"]);
let currentStatus = { state: "ready", message: "" };
const statusListeners = new Set();

export function getPlanStateStatus() {
  return currentStatus;
}

export function subscribePlanStateStatus(listener) {
  statusListeners.add(listener);
  // Same guard publishStatus applies: one broken listener must not break
  // subscribing or its peers.
  try {
    listener(currentStatus);
  } catch (error) {
    console.warn("[planState] status listener failed:", error);
  }
  return () => {
    statusListeners.delete(listener);
  };
}

// Acknowledgement clears the visible failure after quarantine — the payload
// stays aside for recovery and the app runs on its (empty) in-memory state,
// which cannot dispatch anything.
export function acknowledgePlanStateIssue() {
  publishStatus("ready", "");
}

function publishStatus(state, message) {
  if (!STATUS_STATES.includes(state)) return;
  currentStatus = { state, message };
  for (const listener of statusListeners) {
    try {
      listener(currentStatus);
    } catch (error) {
      // A broken listener must not break the write path — surface, continue.
      console.warn("[planState] status listener failed:", error);
    }
  }
}

// --- integrity --------------------------------------------------------------
//
// A synchronous integrity tripwire over the canonical form. loadPlans must
// stay synchronous (useState initializer), so this is a non-cryptographic
// FNV-1a rather than the record document's crypto.subtle checksum. It
// detects accidental corruption and hand edits; it is not a defense against
// someone who can rewrite localStorage (they can recompute any checksum).
function envelopeChecksum(payload) {
  const canonical = canonicalJson(payload);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}-${canonical.length}`;
}

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

// Returns an allowlisted attempt record, or null when the entry cannot be
// keyed (no valid sequence) — corrupt entries are dropped, never repaired.
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
  };
}

// Re-derives every attempt key from its own sequence, so the map is always
// keyed by the deterministic `${planId}:${sequence}` id whatever key the
// (possibly drifted) stored entry arrived under.
function sanitizeAttempts(attempts, planId) {
  if (!attempts || typeof attempts !== "object") return {};
  const next = {};
  for (const entry of Object.values(attempts)) {
    const attempt = sanitizeAttempt(entry);
    if (!attempt) continue;
    next[installmentKey(planId, attempt.sequence)] = attempt;
  }
  return next;
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
  const envelope = {
    version: CURRENT_VERSION,
    savedAt: Date.now(),
    plans: (Array.isArray(plans) ? plans : []).map(sanitizePlan).filter(Boolean),
  };
  // The checksum covers everything except itself (symmetric with readEnvelope).
  envelope.checksum = envelopeChecksum(envelope);
  return envelope;
}

// --- storage I/O ------------------------------------------------------------

let pendingEnvelope = null;
let pendingTimer = null;

function writeEnvelope(envelope) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    // Recovery visibility: clear a write failure once a write lands again.
    // A load-time status (corrupt/invalid_rows) is NOT cleared here — those
    // describe quarantined data, not a transient write problem.
    if (currentStatus.state === "write_failed") publishStatus("ready", "");
    return true;
  } catch (err) {
    // Quota/private-mode failures must not crash the payment flow, but the
    // failure stays visible — a silent drop here would look exactly like a
    // lost attempt record.
    console.warn("[planState] failed to persist plan state:", err);
    publishStatus("write_failed", "Plans are not persisting — payments will not survive a restart. Dispatch is paused until storage writes succeed.");
    return false;
  }
}

function quarantinePlans(raw, reason, version) {
  const payload = { reason, quarantinedAt: new Date().toISOString(), raw };
  if (version !== undefined) payload.version = version;
  try {
    window.localStorage.setItem(QUARANTINE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Quarantine is best-effort: the corrupt payload is at least out of the
    // live key path after the next successful write.
    console.warn("[planState] could not write quarantine payload:", error);
  }
}

// Reads one parsed envelope into { plans, dropped }, or a failure shape:
// { unknownVersion } or { corrupt }. Legacy envelopes without a checksum are
// accepted (they predate the integrity tripwire).
function readEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { plans: [], dropped: 0 };
  if (parsed.version !== CURRENT_VERSION) {
    return { unknownVersion: parsed.version };
  }
  if (parsed.checksum !== undefined) {
    const { checksum, ...payload } = parsed;
    if (envelopeChecksum(payload) !== checksum) {
      return { corrupt: "checksum_mismatch" };
    }
  }
  const rows = Array.isArray(parsed.plans) ? parsed.plans : [];
  const plans = [];
  let dropped = 0;
  for (const row of rows) {
    const plan = sanitizePlan(row);
    if (plan) plans.push(plan);
    else dropped += 1;
  }
  return { plans, dropped };
}

// --- public API -------------------------------------------------------------

// Restores the persisted plans array. Malformed JSON, checksum failures,
// unknown versions, and unavailable storage all resolve to safe defaults —
// this runs at mount and must never throw. Failures that mean "the stored
// bytes are not ours" quarantine the raw payload and publish a status; the
// durable-payments hook folds that into the banner and dispatch gate.
export function loadPlans() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      quarantinePlans(raw, "unparseable_json");
      publishStatus("corrupt", "Stored plan state is corrupt — it was quarantined and the app starts without it.");
      return [];
    }
    const read = readEnvelope(parsed);
    if (read.corrupt) {
      quarantinePlans(raw, read.corrupt);
      publishStatus("corrupt", "Stored plan state failed its integrity check — it was quarantined and the app starts without it.");
      return [];
    }
    if (read.unknownVersion !== undefined) {
      // An unknown version means the bytes were written by newer/other code —
      // quarantined, never guessed at or downgraded.
      quarantinePlans(raw, "unknown_version", read.unknownVersion);
      publishStatus("unknown_version", `Stored plan state was written by a newer version (${read.unknownVersion}) — it was quarantined, never guessed at.`);
      return [];
    }
    if (read.dropped > 0) {
      publishStatus("invalid_rows", `${read.dropped} stored plan${read.dropped === 1 ? " was" : "s were"} excluded for having an invalid form — re-add from the editor.`);
    }
    return read.plans;
  } catch (err) {
    console.warn("[planState] could not load plan state, using defaults:", err);
    // Read-path failure (e.g. privacy-mode storage): start empty; the first
    // write attempt will surface write_failed and halt dispatch if writes
    // fail there too.
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

// Pure update: upserts the allowlisted attempt for `${planId}:${sequence}`.
// Returns a new plans array, or the SAME reference when nothing changed
// (unknown plan, invalid attempt) so callers can detect the no-op without a
// deep compare. Never throws.
export function applyAttempt(plans, planId, attempt) {
  if (!Array.isArray(plans) || plans.length === 0) return plans;
  const sanitized = sanitizeAttempt(attempt);
  if (!sanitized || typeof planId !== "string" || !planId) return plans;
  const index = plans.findIndex((plan) => plan && plan.id === planId);
  if (index === -1) return plans;
  const current = plans[index];
  const key = installmentKey(planId, sanitized.sequence);
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
export function recordAttempt(plans, planId, attempt) {
  const next = applyAttempt(plans, planId, attempt);
  if (next === plans) return plans;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingEnvelope = null;
  }
  writeEnvelope(buildEnvelope(next));
  return next;
}
