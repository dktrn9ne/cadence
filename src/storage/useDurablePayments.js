// The React seam over the payments store: hydrate on mount (recovery before
// any timer runs), persist on change only after hydration, and expose the
// status the dashboard gates dispatch on.
//
// Guarantees:
// - No state change is persisted before hydration resolves, so a stale empty
//   render can never overwrite the durable document.
// - Hydration is a recovery sequence: in-flight attempts become `unresolved`
//   (append-only, idempotent under StrictMode's double mount), overdue
//   nextRunAt values clamp into the grace window, and plans pinned to a
//   different payer pause when a wallet is already connected.
// - A failing write (quota, privacy mode) halts dispatch visibly and clears
//   itself the next time a write succeeds.
// - corrupt / unknown_version start the app empty with the raw payload
//   quarantined; dispatch stays halted until the user acknowledges.
import { useCallback, useEffect, useRef, useState } from "react";
import { load, save } from "./paymentsStore.js";
import { PAYER_MATCH, clampOverdue, payerMatchesPlan } from "../domain/installments.js";
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

export function useDurablePayments({
  people,
  history,
  journal,
  journalSeq,
  walletAddress = "",
  applyHydratedState,
}) {
  const [hydrated, setHydrated] = useState(false);
  const [storageStatus, setStorageStatus] = useState(HYDRATING);

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
      setStorageStatus((current) =>
        current.state === "write_failed" ? { state: "ready", message: null } : current,
      );
    } else {
      setStorageStatus({
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
        setStorageStatus({
          state: result.status,
          message:
            result.status === "corrupt"
              ? "Stored payment data failed validation and was quarantined. Starting empty."
              : `Stored payment data was written by a newer version (schema ${result.schemaVersion}). Starting empty.`,
          quarantined: result.quarantine?.stored ?? false,
          schemaVersion: result.schemaVersion,
          reason: result.reason,
        });
        hydratedRef.current = true;
        setHydrated(true);
        return;
      }

      if (result.status === "empty") {
        setStorageStatus({ state: "ready", message: null });
        hydratedRef.current = true;
        setHydrated(true);
        return;
      }

      // ok / invalid: recover before activation.
      const now = Date.now();
      const recovered = reconcileInFlightAttempts(
        { journal: result.data.journal, journalSeq: result.data.journalSeq },
        now,
      );
      const plans = result.data.plans.map((plan) => ({
        ...plan,
        nextRunAt: clampOverdue(plan.nextRunAt, now),
      }));

      // Hydration-time payer pause: only meaningful when a wallet is already
      // connected; mid-session wallet changes are refused at dispatch time.
      const pausedPlans = [];
      if (walletAddress) {
        for (const plan of plans) {
          if (payerMatchesPlan(plan, walletAddress) === PAYER_MATCH.MISMATCH) {
            pausedPlans.push(plan.id);
            plan.active = false;
            plan.nextRunAt = null;
          }
        }
      }

      const invalidEntries = result.invalidEntries ?? [];
      applyRef.current?.({
        plans,
        history: result.data.history,
        journal: recovered.journal,
        journalSeq: recovered.journalSeq,
      });

      hydratedRef.current = true;
      setHydrated(true);

      if (invalidEntries.length > 0) {
        setStorageStatus({
          state: "invalid_rows",
          message: `${invalidEntries.length} stored plan${invalidEntries.length === 1 ? "" : "s"} failed validation and ${invalidEntries.length === 1 ? "was" : "were"} excluded.`,
          invalidEntries,
        });
        return;
      }

      const recoveredCount = recovered.recovered.length;
      setStorageStatus(
        recoveredCount > 0
          ? {
              state: "recovered",
              message: `${recoveredCount} payment${recoveredCount === 1 ? "" : "s"} need${recoveredCount === 1 ? "s" : ""} review after restart.`,
              recovered,
              pausedPlans,
            }
          : { state: "ready", message: null, pausedPlans: pausedPlans.length > 0 ? pausedPlans : undefined },
      );
    })();
  }, [walletAddress]);

  // Persistence: every state change after hydration, never before. The ref
  // gate is synchronous so even a same-tick change cannot write pre-hydration.
  useEffect(() => {
    if (!hydratedRef.current) return;
    persist({ plans: people, history, journal, journalSeq });
  }, [people, history, journal, journalSeq, persist]);

  const acknowledgeStorageIssue = useCallback(() => {
    setStorageStatus((current) =>
      current.state === "corrupt" || current.state === "unknown_version" || current.state === "invalid_rows"
        ? { state: "ready", message: null }
        : current,
    );
  }, []);

  return {
    hydrated,
    storageStatus,
    storageHalted: isHaltingState(storageStatus.state),
    acknowledgeStorageIssue,
  };
}
