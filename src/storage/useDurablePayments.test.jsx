// Hydration-hook integration tests over the durable payment record.
// Fixtures only — never a live seed.
//
// Scope note: this hook owns the RECORD document (history + journal). Plans
// restore synchronously via planState before this hook mounts, so plan-level
// restoration, overdue clamping, and hydration-time payer pauses belong to
// the planState/recovery stack — covered there and in the wiring tests.
import React, { useCallback, useState } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDurablePayments } from "./useDurablePayments.js";
import { QUARANTINE_KEY, STORE_KEY, checksumOf, save } from "./paymentsStore.js";
import { OUTCOME_LABELS } from "../domain/installments.js";

const PAYER = "rFixtur3PayerAcct11111111111111111111";
const DEST = "rFixtur3DestAcct11111111111111111111";
const HASH = "44F0FAKEHASH0000000000000000000000000000000000000000000000000000";

// Created once per module so timestamps cannot drift between fixture and
// assertion.
const AT_START = "2026-10-09T17:41:02.000Z";
const AT_OUTCOME = "2026-10-09T17:41:05.000Z";

const startedEntry = (seq = 1) => ({
  seq,
  at: AT_START,
  type: "attempt_started",
  status: "submitted",
  installmentId: "person-1734:3",
  planId: "person-1734",
  sequence: 3,
  attemptNo: 1,
  amount: "2.666667",
  destination: DEST,
  payerAddress: PAYER,
  source: "scheduled",
});

const outcomeEntry = (seq = 2, status = OUTCOME_LABELS.VALIDATED_SUCCESS, extras = {}) => ({
  seq,
  at: AT_OUTCOME,
  type: "attempt_outcome",
  status,
  installmentId: "person-1734:3",
  attemptNo: 1,
  ...extras,
});

// Terminal attempt: nothing in flight, nothing to recover.
const settledJournal = () => [
  startedEntry(),
  outcomeEntry(2, OUTCOME_LABELS.VALIDATED_SUCCESS, { txHash: HASH, ledgerResult: "tesSUCCESS" }),
];

// Bare started attempt: still in flight — recovery must relabel it unresolved.
const inFlightJournal = () => [startedEntry()];

const historyFixture = () => [
  { id: "history-1", at: "2026-10-09T17:41:00.000Z", status: "success", title: "Payment submitted", detail: HASH },
];

const docFixture = (overrides = {}) => ({
  history: historyFixture(),
  journal: settledJournal(),
  journalSeq: 2,
  ...overrides,
});

// Two-way harness: the hook hydrates back into the same state that feeds it,
// mirroring how the dashboard consumes it.
function Harness({ capture }) {
  const [doc, setDoc] = useState({ history: [], journal: [], journalSeq: 0 });
  const applyHydratedState = useCallback((next) => setDoc(next), []);
  const hook = useDurablePayments({
    history: doc.history,
    journal: doc.journal,
    journalSeq: doc.journalSeq,
    applyHydratedState,
  });
  capture({ hook, doc, setDoc });
  return null;
}

const renderHarness = ({ strict = false } = {}) => {
  const ref = { current: null };
  const capture = (value) => {
    ref.current = value;
  };
  const tree = <Harness capture={capture} />;
  render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
  return ref;
};

const hydratedState = async (ref) => {
  await waitFor(() => expect(ref.current.hook.hydrated).toBe(true));
  return ref.current;
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("hydration", () => {
  it("restores history and the journal from storage (survive restart)", async () => {
    await save(docFixture());
    const ref = renderHarness();
    await hydratedState(ref);

    const { doc } = ref.current;
    expect(doc.history).toEqual(historyFixture());
    expect(doc.journal).toEqual(settledJournal());
    expect(doc.journalSeq).toBe(2);
    expect(ref.current.hook.storageHalted).toBe(false);
  });

  it("never persists the pre-hydration empty render over stored data", async () => {
    await save(docFixture());
    const ref = renderHarness();
    await hydratedState(ref);

    // The stored records are still there after hydration's own first save.
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    expect(stored.history).toHaveLength(1);
    expect(stored.journal).toHaveLength(2);
  });

  it("reports ready on a fresh install and persists later changes", async () => {
    const ref = renderHarness();
    await hydratedState(ref);
    expect(ref.current.hook.storageStatus.state).toBe("ready");

    act(() => {
      ref.current.setDoc({ ...docFixture() });
    });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
      expect(stored?.journalSeq).toBe(2);
    });
  });
});

describe("recovery on load", () => {
  it("relabels in-flight attempts unresolved exactly once, including under StrictMode", async () => {
    await save(docFixture({ journal: inFlightJournal(), journalSeq: 1 }));
    const ref = renderHarness({ strict: true });
    await hydratedState(ref);

    const outcomes = ref.current.doc.journal.filter(
      (entry) => entry.type === "attempt_outcome" && entry.status === OUTCOME_LABELS.UNRESOLVED,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].installmentId).toBe("person-1734:3");
    expect(ref.current.doc.journal[0]).toEqual(startedEntry()); // append-only: original intact
    expect(ref.current.hook.storageStatus.state).toBe("recovered");
  });
});

describe("load failure states in the hook", () => {
  it("halts on corrupt storage, quarantines, and unblocks on acknowledge", async () => {
    localStorage.setItem(STORE_KEY, "{not json at all");
    const ref = renderHarness();
    await hydratedState(ref);

    expect(ref.current.hook.storageStatus.state).toBe("corrupt");
    expect(ref.current.hook.storageHalted).toBe(true);
    expect(ref.current.doc.history).toEqual([]);
    expect(ref.current.doc.journal).toEqual([]);
    expect(localStorage.getItem(QUARANTINE_KEY)).not.toBeNull();

    act(() => {
      ref.current.hook.acknowledgeStorageIssue();
    });
    expect(ref.current.hook.storageHalted).toBe(false);
  });

  it("halts on unknown schemaVersion and hydrates nothing", async () => {
    await save(docFixture());
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    stored.schemaVersion = 99;
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const ref = renderHarness();
    await hydratedState(ref);

    expect(ref.current.hook.storageStatus.state).toBe("unknown_version");
    expect(ref.current.hook.storageHalted).toBe(true);
    expect(ref.current.doc.history).toEqual([]);
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY));
    expect(quarantined.schemaVersion).toBe(99);
  });

  it("excludes invalid record rows but does not halt dispatch", async () => {
    await save(docFixture());
    const stored = JSON.parse(localStorage.getItem(STORE_KEY));
    stored.journal.push({ seq: 0, type: "attempt_started", installmentId: "no-seq" });
    const { checksum, ...payload } = stored;
    stored.checksum = await checksumOf(payload);
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));

    const ref = renderHarness();
    await hydratedState(ref);

    expect(ref.current.doc.journal.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(ref.current.hook.storageStatus.state).toBe("invalid_rows");
    expect(ref.current.hook.storageHalted).toBe(false);
  });
});

describe("write failure handling", () => {
  it("halts dispatch on a failing write and clears when a write succeeds", async () => {
    const ref = renderHarness();
    await hydratedState(ref);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    act(() => {
      ref.current.setDoc({ ...docFixture() });
    });
    await waitFor(() => expect(ref.current.hook.storageHalted).toBe(true));
    expect(ref.current.hook.storageStatus.state).toBe("write_failed");

    spy.mockRestore();
    act(() => {
      const doc = ref.current.doc;
      ref.current.setDoc({ ...doc, journalSeq: doc.journalSeq + 1 });
    });
    await waitFor(() => expect(ref.current.hook.storageHalted).toBe(false));
    expect(ref.current.hook.storageStatus.state).toBe("ready");
  });

  it("folds a planState write failure into the same halt", async () => {
    // planState is a separate document with its own write path; its failure
    // must surface through the same banner and gate, not a second channel.
    const { recordAttempt } = await import("./planState.js");
    const ref = renderHarness();
    await hydratedState(ref);
    expect(ref.current.hook.storageHalted).toBe(false);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Attempts write immediately (they bypass savePlans' debounce).
    act(() => {
      recordAttempt([{ id: "person-planstate", attempts: {} }], "person-planstate", {
        sequence: 1,
        status: "attempting",
        amount: "1.000000",
      });
    });
    await waitFor(() => expect(ref.current.hook.storageHalted).toBe(true));
    expect(ref.current.hook.storageStatus.state).toBe("write_failed");
    spy.mockRestore();
  });
});
