import { describe, expect, it, vi } from "vitest";
import { recoverPaymentHash } from "./recoverPaymentHash.js";

const hash = "AB".repeat(32);
const attempt = { sequence: 0, attemptNo: 1, status: "unresolved", hash: null, payer: "rPayer", destination: "rRecipient", amount: "1.000000" };
const plans = () => [{ id: "plan", paidCount: 0, attempts: { "plan:0#1": { ...attempt } } }];

describe("hashless payment recovery", () => {
  it("classifies the supplied hash against the original identity without submitting", async () => {
    const reconcile = vi.fn(async () => ({ outcome: "validated_success" }));
    const input = plans();
    const result = await recoverPaymentHash({ plans: input, planId: "plan", hash: hash.toLowerCase(), reconcile });
    expect(reconcile).toHaveBeenCalledWith(hash, { payer: "rPayer", destination: "rRecipient", amount: "1.000000" });
    expect(result).toMatchObject({ status: "validated_success", hash });
    expect(input[0].paidCount).toBe(0); // caller commits exactly once after persistence
    expect(input[0].attempts["plan:0#1"].hash).toBeNull();
  });
  it.each(["validated_failure", "still_unknown"])("handles a %s ledger answer safely", async (outcome) => {
    const recovery = recoverPaymentHash({ plans: plans(), planId: "plan", hash, reconcile: async () => ({ outcome }) });
    if (outcome === "still_unknown") await expect(recovery).rejects.toThrow("has not confirmed");
    else expect((await recovery).status).toBe("validated_failure");
  });
  it("rejects an identity mismatch, malformed hash, and reuse of a prior receipt", async () => {
    await expect(recoverPaymentHash({ plans: plans(), planId: "plan", hash, reconcile: async () => ({ anomaly: "identity_mismatch" }) })).rejects.toThrow("does not match");
    const reconcile = vi.fn();
    await expect(recoverPaymentHash({ plans: plans(), planId: "plan", hash: "bad", reconcile })).rejects.toThrow("64-character");
    const input = [...plans(), { id: "other", attempts: { other: { ...attempt, hash: hash.toLowerCase(), status: "validated_success" } } }];
    await expect(recoverPaymentHash({ plans: input, planId: "plan", hash, reconcile })).rejects.toThrow("already attached");
    expect(reconcile).not.toHaveBeenCalled();
  });
});
