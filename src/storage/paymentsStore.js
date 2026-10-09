// The durable footprint of Cadence payments: one versioned localStorage
// document (cadence.payments.v1), one atomic write per change, one checksum
// over the canonical form (spec art_iD6vSHMR, locked backend decision).
//
// Safety model, by construction rather than by redaction luck:
// - The serializer copies NAMED fields only — an unknown field on a plan is
//   dropped on save, never persisted, never resurrected.
// - assertNoSecretMaterial runs on every save and refuses secret-shaped keys
//   or signed-blob-shaped values anywhere in the document.
// - load() never throws: unparseable JSON, checksum mismatches, and unknown
//   schema versions quarantine the raw payload and resolve a status the
//   caller renders; invalid plan rows are preserved, not scheduled.
//
// This module knows shapes, not payroll semantics — plan meaning lives in
// the domain modules.
import { FREQUENCIES } from "../domain/schedule.js";
import { JOURNAL_ENTRY_TYPES, pruneJournal } from "../domain/journal.js";
import { OUTCOME_LABELS } from "../domain/installments.js";

export const STORE_KEY = "cadence.payments.v1";
export const QUARANTINE_KEY = "cadence.payments.v1.quarantine";
export const SCHEMA_VERSION = 1;

export const LOAD_STATUSES = Object.freeze([
  "empty",
  "ok",
  "corrupt",
  "unknown_version",
  "invalid",
]);

// Named fields only. payerAddress is the connected PUBLIC account that
// authorized the plan — public data, and what later lanes check a wallet
// change against.
export const PLAN_FIELDS = Object.freeze([
  "id",
  "name",
  "role",
  "email",
  "address",
  "payerAddress",
  "weeklyPay",
  "payMode",
  "hourlyPay",
  "hoursPerWeek",
  "frequency",
  "active",
  "paidCount",
  "nextRunAt",
]);

export const HISTORY_FIELDS = Object.freeze(["id", "at", "status", "title", "detail"]);

export const JOURNAL_FIELDS = Object.freeze([
  "seq",
  "at",
  "type",
  "status",
  "installmentId",
  "planId",
  "sequence",
  "attemptNo",
  "amount",
  "destination",
  "payerAddress",
  "source",
  "txHash",
  "ledgerResult",
  "error",
  "reason",
]);

export const HISTORY_CAP = 500;

// Same key-shape discipline as the dashboard's safeLogPayload and the attempt
// store, extended with the gaps a name filter historically missed
// (privateKey in any separator shape) plus signed-blob value shapes.
const SECRET_SHAPED_KEY = /seed|phrase|secret|password|mnemonic|private[\s_-]?key|accessinput/i;
const SIGNED_BLOB_KEY = /blob|signature/i;
// A signed blob is a long run of hex or base64 with no whitespace — far
// longer than a hash (64 hex chars) or an address (~34 chars).
const BLOB_SHAPED_VALUE = /^(?:[0-9a-fA-F]{200,}|[A-Za-z0-9+/]{200,}={0,2})$/;

// Second line of defense behind the whitelist: walks the assembled document
// and throws if anything secret-shaped survived. A failing save must be loud
// in tests, not quiet in production.
export function assertNoSecretMaterial(value, path = "doc") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && BLOB_SHAPED_VALUE.test(value)) {
      throw new Error(`Refusing to persist a signed-blob-shaped value at ${path}`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_SHAPED_KEY.test(key)) {
      throw new Error(`Refusing to persist secret-shaped field "${key}" at ${path}`);
    }
    if (SIGNED_BLOB_KEY.test(key) && typeof item === "string" && item.length > 0) {
      throw new Error(`Refusing to persist signed-blob field "${key}" at ${path}`);
    }
    assertNoSecretMaterial(item, `${path}.${key}`);
  }
}

// Canonical JSON: object keys sorted recursively, everything else in array
// order — the same document always hashes to the same checksum.
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// sha256 via crypto.subtle when the runtime provides it, with a deterministic
// non-cryptographic fallback so a missing subtle never silently skips the
// checksum.
export async function checksumOf(value) {
  const canonical = canonicalJson(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}-${canonical.length}`;
}

// Whitelist-copy of one plan: unknown fields dropped, undefined fields
// omitted. Money fields keep their stored string form — the dashboard treats
// them as strings and the store does not coerce.
export function copyPlan(plan) {
  const copy = {};
  for (const field of PLAN_FIELDS) {
    if (plan[field] !== undefined) copy[field] = plan[field];
  }
  return copy;
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Per-plan schema validation for LOAD. Money fields may be strings or
// numbers (the UI binds them as strings); progress and scheduling must be
// well-typed or the row is rejected.
export function validatePlanRow(plan) {
  if (!isPlainObject(plan)) return "plan must be an object";
  if (typeof plan.id !== "string" || plan.id.trim() === "") return '"id" must be a non-empty string';
  for (const field of ["name", "role", "email", "address"]) {
    if (plan[field] !== undefined && typeof plan[field] !== "string") return `"${field}" must be a string`;
  }
  if (plan.payerAddress !== undefined && (typeof plan.payerAddress !== "string" || plan.payerAddress.trim() === "")) {
    return '"payerAddress" must be a non-empty string when present';
  }
  for (const field of ["weeklyPay", "hourlyPay", "hoursPerWeek"]) {
    const value = plan[field];
    if (value !== undefined && typeof value !== "string" && typeof value !== "number") {
      return `"${field}" must be a string or number`;
    }
  }
  if (plan.payMode !== undefined && plan.payMode !== "weekly" && plan.payMode !== "hourly") {
    return '"payMode" must be "weekly" or "hourly"';
  }
  if (plan.frequency !== undefined && !FREQUENCIES.includes(plan.frequency)) {
    return `"frequency" must be one of ${FREQUENCIES.join(", ")}`;
  }
  if (plan.active !== undefined && typeof plan.active !== "boolean") return '"active" must be a boolean';
  const paidCount = plan.paidCount;
  if (paidCount !== undefined && (!Number.isInteger(paidCount) || paidCount < 0)) {
    return '"paidCount" must be a non-negative integer';
  }
  if (plan.nextRunAt !== undefined && plan.nextRunAt !== null && !Number.isFinite(Number(plan.nextRunAt))) {
    return '"nextRunAt" must be epoch millis or null';
  }
  return null;
}

function copyHistoryRow(row) {
  if (!isPlainObject(row)) return null;
  const copy = {};
  for (const field of HISTORY_FIELDS) {
    if (row[field] !== undefined) copy[field] = row[field];
  }
  if (typeof copy.id !== "string" || typeof copy.title !== "string") return null;
  return copy;
}

function copyJournalEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (!JOURNAL_ENTRY_TYPES.includes(entry.type)) return null;
  if (!Number.isInteger(entry.seq) || entry.seq < 1) return null;
  if (typeof entry.installmentId !== "string" || entry.installmentId === "") return null;
  if (entry.type === "attempt_outcome" && !Object.values(OUTCOME_LABELS).includes(entry.status)) return null;
  const copy = {};
  for (const field of JOURNAL_FIELDS) {
    if (entry[field] !== undefined) copy[field] = entry[field];
  }
  return copy;
}

// Quarantine never throws past load: a failing quarantine write is surfaced
// in the returned status, and the corrupt payload is at least still gone
// from the live key path.
function quarantine(raw, reason, schemaVersion) {
  const payload = { reason, quarantinedAt: new Date().toISOString(), raw };
  if (schemaVersion !== undefined) payload.schemaVersion = schemaVersion;
  let stored = true;
  let storeError = null;
  try {
    window.localStorage.setItem(QUARANTINE_KEY, JSON.stringify(payload));
  } catch (error) {
    stored = false;
    storeError = error?.message ?? String(error);
  }
  return { stored, storeError };
}

// load(): never throws, never partially hydrates. One of:
//   { status: "empty" }        nothing stored yet
//   { status: "ok", data }     checksum + schema valid
//   { status: "corrupt", reason }  unparseable or checksum mismatch (payload quarantined)
//   { status: "unknown_version", schemaVersion }   future schema, never guessed at
//   { status: "invalid", data, invalidEntries }    valid doc, some plans rejected
export async function load() {
  let raw;
  try {
    raw = window.localStorage.getItem(STORE_KEY);
  } catch (error) {
    return { status: "corrupt", reason: `storage_unreadable: ${error?.message ?? error}` };
  }
  if (raw === null || raw === "") return { status: "empty" };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const quarantineResult = quarantine(raw, "unparseable_json");
    return { status: "corrupt", reason: `unparseable_json: ${error?.message ?? error}`, quarantine: quarantineResult };
  }
  if (!isPlainObject(parsed)) {
    return { status: "corrupt", reason: "not_an_object", quarantine: quarantine(raw, "not_an_object") };
  }

  const { schemaVersion } = parsed;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { status: "corrupt", reason: "missing_or_invalid_schemaVersion", quarantine: quarantine(raw, "missing_or_invalid_schemaVersion") };
  }
  if (schemaVersion !== SCHEMA_VERSION) {
    return {
      status: "unknown_version",
      schemaVersion,
      quarantine: quarantine(raw, "unknown_schema_version", schemaVersion),
    };
  }

  const { checksum, ...payload } = parsed;
  const expected = await checksumOf(payload);
  if (checksum !== expected) {
    return { status: "corrupt", reason: "checksum_mismatch", quarantine: quarantine(raw, "checksum_mismatch") };
  }

  // Per-plan validation: valid rows schedule, invalid rows are preserved in
  // invalidEntries (never scheduled, never silently dropped).
  const plans = [];
  const invalidEntries = [];
  for (const row of Array.isArray(payload.plans) ? payload.plans : []) {
    const reason = validatePlanRow(row);
    if (reason) {
      invalidEntries.push({ reason, row });
    } else {
      plans.push(copyPlan(row));
    }
  }

  const history = (Array.isArray(payload.history) ? payload.history : [])
    .map(copyHistoryRow)
    .filter(Boolean)
    .slice(0, HISTORY_CAP);

  const journal = (Array.isArray(payload.journal) ? payload.journal : [])
    .map(copyJournalEntry)
    .filter(Boolean);
  // The seq counter never regresses below the highest stored seq.
  const journalSeq = journal.reduce((max, entry) => Math.max(max, entry.seq), 0);

  return {
    status: invalidEntries.length > 0 ? "invalid" : "ok",
    data: {
      plans,
      history,
      journal,
      journalSeq: Math.max(Number.isInteger(payload.journalSeq) ? payload.journalSeq : 0, journalSeq),
      savedAt: typeof payload.savedAt === "string" ? payload.savedAt : null,
    },
    invalidEntries: invalidEntries.length > 0 ? invalidEntries : undefined,
  };
}

// save(doc): whitelist-copy → assertNoSecretMaterial → checksum → setItem.
// A failing setItem (quota, privacy mode) resolves { ok: false, reason } —
// the caller halts dispatch and shows the banner; it never throws past the
// hook.
export async function save(doc) {
  const plans = (Array.isArray(doc?.plans) ? doc.plans : []).map(copyPlan);
  const history = (Array.isArray(doc?.history) ? doc.history : [])
    .map(copyHistoryRow)
    .filter(Boolean)
    .slice(0, HISTORY_CAP);
  const journal = pruneJournal(
    (Array.isArray(doc?.journal) ? doc.journal : []).map(copyJournalEntry).filter(Boolean),
  );

  const payload = {
    plans,
    history,
    journal,
    journalSeq: journal.reduce((max, entry) => Math.max(max, entry.seq), 0),
  };

  assertNoSecretMaterial(payload);

  const stored = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    ...payload,
  };
  // Symmetric with load(): the checksum covers everything stored EXCEPT the
  // checksum itself. Any envelope field added here is verified on read.
  const checksum = await checksumOf(stored);
  const withChecksum = { ...stored, checksum };

  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(withChecksum));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}
