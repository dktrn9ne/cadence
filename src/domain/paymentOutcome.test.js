import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_STATES,
  OUTCOME_STATES,
  installmentId,
  transition,
} from "./paymentOutcome.js";

// Oracle: the legal moves, transcribed from the spec's state model
// (art_XPj3pWA4), independent of the implementation's TRANSITIONS table.
const LEGAL_MOVES = Object.freeze([
  ["scheduled", "awaiting_signature"],
  ["awaiting_signature", "submitted"],
  ["awaiting_signature", "unresolved"],
  ["awaiting_signature", "validated_failure"],
  ["submitted", "unresolved"],
  ["submitted", "validated_success"],
  ["submitted", "validated_failure"],
  ["unresolved", "validated_success"],
  ["unresolved", "validated_failure"],
]);

const ALL_STATES = Object.freeze(Object.values(OUTCOME_STATES));
const FIXED_NOW = 1_760_000_000_000;

const recordIn = (state, extras = {}) => ({
  id: "attempt-person-1734:0-1",
  installmentId: "person-1734:0",
  state,
  ...extras,
});

describe("installment outcome domain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("installmentId", () => {
    it("is `${planId}:${sequence}`", () => {
      expect(installmentId("person-1734", 0)).toBe("person-1734:0");
      expect(installmentId("person-1734", 12)).toBe("person-1734:12");
      expect(installmentId("plan-x", 3)).toBe("plan-x:3");
    });

    it("is zero-based — sequence 0 is the first installment", () => {
      expect(installmentId("plan-x", 0)).toBe("plan-x:0");
    });
  });

  describe("ACTIVE_STATES", () => {
    it("holds exactly the three lock-holding states", () => {
      expect([...ACTIVE_STATES].sort()).toEqual([
        "awaiting_signature",
        "submitted",
        "unresolved",
      ]);
    });

    it("excludes scheduled (not yet dispatched) and terminal states (lock released)", () => {
      expect(ACTIVE_STATES.has("scheduled")).toBe(false);
      expect(ACTIVE_STATES.has("validated_success")).toBe(false);
      expect(ACTIVE_STATES.has("validated_failure")).toBe(false);
    });
  });

  describe("transition — legal moves (full enumeration)", () => {
    for (const [from, to] of LEGAL_MOVES) {
      it(`allows ${from} -> ${to}`, () => {
        const next = transition(recordIn(from, { amount: "12.5000" }), to);
        expect(next.state).toBe(to);
        // Untouched fields carry over; updatedAt is stamped with the clock.
        expect(next.amount).toBe("12.5000");
        expect(next.updatedAt).toBe(FIXED_NOW);
      });
    }

    it("merges the patch into the returned record", () => {
      const next = transition(recordIn("awaiting_signature"), "submitted", {
        hash: "44F0FAKEHASH",
      });
      expect(next.state).toBe("submitted");
      expect(next.hash).toBe("44F0FAKEHASH");
    });

    it("does not mutate the input record", () => {
      const record = recordIn("submitted");
      transition(record, "validated_success", { ledgerResult: "tesSUCCESS" });
      expect(record.state).toBe("submitted");
      expect(record.ledgerResult).toBeUndefined();
    });
  });

  describe("transition — illegal moves (full enumeration)", () => {
    const legal = new Set(LEGAL_MOVES.map(([from, to]) => `${from}->${to}`));

    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        it(`throws on ${from} -> ${to}`, () => {
          expect(() => transition(recordIn(from), to)).toThrow(
            new RegExp(`Illegal outcome transition ${from} -> ${to}`),
          );
        });
      }
    }

    it("throws when the record state is not in the table at all", () => {
      expect(() =>
        transition({ id: "x", installmentId: "person-1734:0", state: "banana" }, "submitted"),
      ).toThrow(/Illegal outcome transition banana -> submitted/);
    });
  });
});
