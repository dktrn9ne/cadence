import { describe, expect, it } from "vitest";
import { buildCrossmarkRlusdPayment, buildRlusdPayment, responseHash } from "../src/domain/payments.js";

// Public address-shaped fixtures only — never a seed, mnemonic, or signed blob.
const PAYER = "rFixturePayerAccount00000000000000000000000";
const DESTINATION = "rFixtureDestinationAccount00000000000000000";

describe("buildRlusdPayment", () => {
  it("builds the exact RLUSD payment transaction JSON", () => {
    expect(
      buildRlusdPayment({ wallet: { address: PAYER }, destination: DESTINATION, amount: "12.5" })
    ).toEqual({
      TransactionType: "Payment",
      Account: PAYER,
      Destination: DESTINATION,
      SourceTag: 2606250005,
      Amount: {
        currency: "524C555344000000000000000000000000000000",
        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
        value: "12.5",
      },
    });
  });
});

describe("buildCrossmarkRlusdPayment", () => {
  it("derives the payment from a connected account string", () => {
    const payment = buildCrossmarkRlusdPayment({ account: PAYER, destination: DESTINATION, amount: "1" });

    expect(payment).toEqual(buildRlusdPayment({ wallet: { address: PAYER }, destination: DESTINATION, amount: "1" }));
    expect(payment.Account).toBe(PAYER);
  });
});

describe("responseHash", () => {
  it("reads the hash from every documented response shape", () => {
    expect(responseHash({ response: { data: { resp: { result: { hash: "H1" } } } } })).toBe("H1");
    expect(responseHash({ response: { data: { result: { hash: "H2" } } } })).toBe("H2");
    expect(responseHash({ data: { resp: { result: { hash: "H3" } } } })).toBe("H3");
    expect(responseHash({ data: { result: { hash: "H4" } } })).toBe("H4");
    expect(responseHash({ result: { hash: "H5" } })).toBe("H5");
    expect(responseHash({ hash: "H6" })).toBe("H6");
  });

  it("prefers the deepest crossmark shape over shallow ones", () => {
    const response = {
      response: { data: { resp: { result: { hash: "deepest" } } } },
      hash: "shallow",
    };
    expect(responseHash(response)).toBe("deepest");
  });

  it("falls back to null when no shape matches", () => {
    expect(responseHash(null)).toBe(null);
    expect(responseHash(undefined)).toBe(null);
    expect(responseHash({})).toBe(null);
    expect(responseHash({ response: {} })).toBe(null);
    expect(responseHash({ response: { data: {} } })).toBe(null);
    expect(responseHash({ result: {} })).toBe(null);
  });
});
