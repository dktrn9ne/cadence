// The React seam over the durable payment record: hydrate the record document
// on mount (recovery before any timer runs), persist on change only after
// hydration, and expose the status the dashboard gates dispatch on.
//
// Scope on the merged stack: the record document is history + journal
// (cadence.payments.v1, src/storage/paymentsStore.js). Plans restore
// synchronously via planState (cadence-plans-v1) before this hook mounts, so
// this hook does not write plan state — it folds planState's load/write
// failures into the same storage banner and dispatch gate the record status
// drives.
//
// Guarantees:
// - No record change is persisted before hydration resolves, so a stale empty
//   render can never overwrite the durable document.
// - Hydration is a recovery sequence: journal attempts that were in flight
//   when the app died become `unresolved` (append-only, idempotent under
//   StrictMode's double mount). Plan-level recovery (missed windows, attempt
//   maps) belongs to the dispatcher/recovery stack and runs there.
// - A failing write (quota, privacy mode) halts dispatch visibly and clears
//   itself the next time a write succeeds.
// - corrupt / unknown_version start the record empty with the raw payload
//   quarantined; dispatch stays halted until the user acknowledges.
import { useCallback, useEffect, useRef, useState } from "react";
import { load, save } from "./paymentsStore.js";
import {
  acknowledgePlanStateIssue,
  getPlanStateStatus,
  subscribePlanStateStatus,
} from "./planState.js";
import { reconcileInFlightAttempts } from "../domain/journal.js";

export const STORAGE_STATES = Object.freeze([
  "hydrating",
  "ready",
  "recovered",
  "invalid_rows",
  "corrupt",
  "unknown_version",
  "write_failed",
]);

const HALTING_STATES = Object.freeze(["corrupt", "unknown_version", "write_failed"]);

export const isHaltingState = (state) => HALTING_STATES.includes(state);

const HYDRATING = Object.freeze({ state: "hydrating", message: null });

// Which of two statuses wins the single banner: the more severe state, with
// halting states above advisory ones.
const STATE_RANK = Object.freeze({
  hydrating: 0,
  ready: 0,
  recovered: 1,
  invalid_rows: 2,
  corrupt: 3,
  unknown_version: 3,
  write_failed: 4,
});

const mergeStatus = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return (STATE_RANK[a.state] ?? 0) >= (STATE_RANK[b.state] ?? 0) ? a : b;
};

export function useDurablePayments({
  history,
  journal,
  journalSeq,
  applyHydratedState,
}) {
  const [hydrated, setHydrated] = useState(false);
  const [recordStatus, setRecordStatus] = useState(HYDRATING);
  // planState loads synchronously during the dashboard's first render, so its
  // load-time status can already be a failure before this effect subscribes —
  // subscribe() replays the current status immediately.
  const [planStateStatus, setPlanStateStatus] = useState(() => getPlanStateStatus());

  useEffect(
    () => subscribePlanStateStatus((next) => setPlanStateStatus({ ...next })),
    [],
  );

  // Refs mirror the gate for synchronous checks inside effects and keep the
  // latest callback without retriggering the hydration effect.
  const hydratedRef = useRef(false);
  const hydrationRef = useRef(null);
  const applyRef = useRef(applyHydratedState);
  applyRef.current = applyHydratedState;

  const persist = useCallback(async (doc) => {
    const result = await save(doc);
    if (result.ok) {
      // A write succeeding after a halt clears the halt; otherwise leave the
      // current status (recovery set it) alone.
      setRecordStatus((current) =>
        current.state === "write_failed" ? { state: "ready", message: null } : current,
      );
    } else {
      setRecordStatus({
        state: "write_failed",
        message: "Payments are not being saved — they will not survive a restart.",
        writeError: result.reason,
      });
    }
    return result;
  }, []);

  // Hydration: one async sequence shared by StrictMode's double mount — the
  // second effect run reuses the in-flight promise instead of re-recovering.
  useEffect(() => {
    if (hydrationRef.current) return;
    hydrationRef.current = (async () => {
      const result = await load();

      if (result.status === "corrupt" || result.status === "unknown_version") {
        setRecordStatus({
          state: result.status,
          message:
            result.status === "corrupt"
              ? "Stored payment records failed validation and were quarantined. Starting empty."
              : `Stored payment records were written by a newer version (schema ${result.schemaVersion}). Starting empty.`,
          quarantined: result.quarantine?.stored ?? false,
          schemaVersion: result.schemaVersion,
          reason: result.reason,
        });
        hydratedRef.current = true;
        setHydrated(true);
        return;
      }

      if (result.status === "empty") {
        setRecordStatus({ state: "ready", message: null });
        hydratedRef.current = true;
        setHydrated(true);
        return;
      }

      // ok / invalid: recover the record before activation — attempts that
      // were in flight at shutdown become `unresolved`, never auto-retried.
      const recovered = reconcileInFlightAttempts(
        { journal: result.data.journal, journalSeq: result.data.journalSeq },
        Date.now(),
      );

      const invalidEntries = result.invalidEntries ?? [];
      applyRef.current?.({
        history: result.data.history,
        journal: recovered.journal,
        journalSeq: recovered.journalSeq,
      });

      hydratedRef.current = true;
      setHydrated(true);

      if (invalidEntries.length > 0) {
        setRecordStatus({
          state: "invalid_rows",
          message: `${invalidEntries.length} stored record ${invalidEntries.length === 1 ? "row was" : "rows were"} excluded for failing validation.`,
          invalidEntries,
        });
        return;
      }

      const recoveredCount = recovered.recovered.length;
      setRecordStatus(
        recoveredCount > 0
          ? {
              state: "recovered",
              message: `${recoveredCount} payment${recoveredCount === 1 ? " needs" : "s need"} review after restart.`,
              recovered,
            }
          : { state: "ready", message: null },
      );
    })();
  }, []);

  // Persistence: every record change after hydration, never before. The ref
  // gate is synchronous so even a same-tick change cannot write pre-hydration.
  useEffect(() => {
    if (!hydratedRef.current) return;
    persist({ history, journal, journalSeq });
  }, [history, journal, journalSeq, persist]);

  const acknowledgeStorageIssue = useCallback(() => {
    // Both documents can be in a halting state independently; acknowledging
    // clears both visible failures. Quarantined payloads stay aside.
    acknowledgePlanStateIssue();
    setRecordStatus((current) =>
      current.state === "corrupt" || current.state === "unknown_version" || current.state === "invalid_rows"
        ? { state: "ready", message: null }
        : current,
    );
  }, []);

  const storageStatus = mergeStatus(recordStatus, planStateStatus);

  return {
    hydrated,
    storageStatus,
    storageHalted: isHaltingState(storageStatus.state),
    acknowledgeStorageIssue,
  };
}
