// Durable per-installment attempt records under cadence-payment-attempts-v1.
// This module is the ONLY writer of that key. Records hold public payment
// data only — payer/destination addresses, exact decimal amounts, hash,
// timestamps — and secret-shaped fields are refused outright. All state
// changes route through the domain transition: the store never invents an
// outcome the machine does not allow.
import {
  OUTCOME_STATES,
  installmentId as makeInstallmentId,
  isActiveState,
  transition,
} from "../domain/paymentOutcome.js";

export const ATTEMPTS_STORAGE_KEY = "cadence-payment-attempts-v1";

export const ATTEMPT_SOURCES = Object.freeze(["manual", "scheduled", "auto_start"]);

export const ERROR_CLASSES = Object.freeze(["sign_rejected", "construction", "network"]);

// Field allowlist. Identity fields are required at creation and immutable
// afterwards; outcome fields arrive only through updateAttempt patches.
const IDENTITY_FIELDS = Object.freeze([
  "planId",
  "sequence",
  "source",
  "payer",
  "destination",
  "amount",
  "currency",
  "issuer",
  "sourceTag",
]);
const OUTCOME_FIELDS = Object.freeze(["hash", "ledgerResult", "errorClass"]);

// Same key-shape discipline as the dashboard's safeLogPayload, plus
// mnemonic/privatekey (any separator shape), which a name-based filter
// historically misses.
const SECRET_SHAPED_KEY = /seed|phrase|secret|password|mnemonic|private[\s_-]?key|accessinput/i;

// Exact decimal strings only — a float never touches an amount.
const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

function requireStorage() {
  if (typeof localStorage === "undefined") {
    throw new Error("attemptStore requires a localStorage environment (browser or jsdom)");
  }
  return localStorage;
}

function readAll() {
  const raw = requireStorage().getItem(ATTEMPTS_STORAGE_KEY);
  if (raw === null) return [];
  let records;
  try {
    records = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${ATTEMPTS_STORAGE_KEY} is corrupt: ${err?.message ?? err}`);
  }
  if (!Array.isArray(records)) {
    throw new Error(`${ATTEMPTS_STORAGE_KEY} is corrupt: expected an array of attempt records`);
  }
  return records;
}

function writeAll(records) {
  requireStorage().setItem(ATTEMPTS_STORAGE_KEY, JSON.stringify(records));
}

function rejectUnknownFields(input, allowed, action) {
  for (const key of Object.keys(input)) {
    if (SECRET_SHAPED_KEY.test(key)) {
      throw new Error(`attemptStore refuses secret-shaped field "${key}" in ${action}`);
    }
    if (!allowed.includes(key)) {
      throw new Error(`Unknown attempt field "${key}" in ${action}`);
    }
  }
}

function requireNonEmptyString(fields, key) {
  const value = fields[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`attempt field "${key}" must be a non-empty string`);
  }
  return value;
}

function validateIdentityFields(fields) {
  requireNonEmptyString(fields, "planId");
  if (!Number.isInteger(fields.sequence) || fields.sequence < 0) {
    throw new Error('attempt field "sequence" must be a non-negative integer');
  }
  if (!ATTEMPT_SOURCES.includes(fields.source)) {
    throw new Error(`attempt field "source" must be one of ${ATTEMPT_SOURCES.join(", ")}`);
  }
  requireNonEmptyString(fields, "payer");
  requireNonEmptyString(fields, "destination");
  requireNonEmptyString(fields, "currency");
  requireNonEmptyString(fields, "issuer");
  if (typeof fields.amount !== "string" || !DECIMAL_STRING.test(fields.amount)) {
    throw new Error('attempt field "amount" must be an exact decimal string (e.g. "12.5000")');
  }
  if (!Number.isInteger(fields.sourceTag) || fields.sourceTag < 0) {
    throw new Error('attempt field "sourceTag" must be a non-negative integer');
  }
}

function validateOutcomePatch(patch) {
  for (const key of ["hash", "ledgerResult"]) {
    const value = patch[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`attempt field "${key}" must be a string or null`);
    }
  }
  if (
    patch.errorClass !== undefined &&
    patch.errorClass !== null &&
    !ERROR_CLASSES.includes(patch.errorClass)
  ) {
    throw new Error(`attempt field "errorClass" must be one of ${ERROR_CLASSES.join(", ")} or null`);
  }
}

// Creates the scheduled attempt record for one installment. Throws if an
// active attempt (awaiting_signature | submitted | unresolved) already exists
// for the same installmentId — the per-installment lock, enforced at the data
// layer so no entry point can bypass it. Terminal records do not block: a
// retried installment numbers a fresh attempt upward.
export function createAttempt(fields) {
  const input = fields ?? {};
  rejectUnknownFields(input, IDENTITY_FIELDS, "createAttempt");
  validateIdentityFields(input);
  const records = readAll();
  const instId = makeInstallmentId(input.planId, input.sequence);
  const existing = records.find(
    (r) => r.installmentId === instId && isActiveState(r.state),
  );
  if (existing) {
    throw new Error(
      `Attempt ${existing.id} is ${existing.state} for installment ${instId} — one active attempt per installment`,
    );
  }
  const attemptNumber = records.filter((r) => r.installmentId === instId).length + 1;
  const now = Date.now();
  const record = {
    id: `attempt-${instId}-${attemptNumber}`,
    installmentId: instId,
    planId: input.planId,
    sequence: input.sequence,
    source: input.source,
    payer: input.payer,
    destination: input.destination,
    amount: input.amount,
    currency: input.currency,
    issuer: input.issuer,
    sourceTag: input.sourceTag,
    hash: null,
    ledgerResult: null,
    errorClass: null,
    state: OUTCOME_STATES.scheduled,
    createdAt: now,
    updatedAt: now,
  };
  writeAll([...records, record]);
  return record;
}

// Moves a record through the domain transition and persists it in one step.
// nextState must be legal from the record's current state or transition()
// throws and nothing is written — a rejected update leaves no partial state.
export function updateAttempt(id, nextState, patch = {}) {
  const changes = patch ?? {};
  rejectUnknownFields(changes, OUTCOME_FIELDS, "updateAttempt");
  validateOutcomePatch(changes);
  const records = readAll();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) {
    throw new Error(`Unknown attempt ${id}`);
  }
  const updated = transition(records[index], nextState, changes);
  records[index] = updated;
  writeAll(records);
  return updated;
}

// The active (lock-holding) attempt for an installment, or null.
export function getActiveAttempt(targetInstallmentId) {
  return (
    readAll().find(
      (r) => r.installmentId === targetInstallmentId && isActiveState(r.state),
    ) ?? null
  );
}
