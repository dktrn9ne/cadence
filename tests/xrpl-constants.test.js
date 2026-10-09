import { describe, expect, it } from "vitest";
import {
  CADENCE_EMPLOYER_WALLET,
  RLUSD_CURRENCY,
  RLUSD_ISSUER,
  SOURCE_TAG,
} from "../src/domain/xrpl-constants.js";

describe("XRPL constants", () => {
  it("pins the RLUSD currency code (hex-encoded RLUSD without issuer)", () => {
    expect(RLUSD_CURRENCY).toBe("524C555344000000000000000000000000000000");
  });

  it("pins the RLUSD issuer", () => {
    expect(RLUSD_ISSUER).toBe("rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De");
  });

  it("pins the Cadence employer wallet", () => {
    expect(CADENCE_EMPLOYER_WALLET).toBe("rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864");
  });

  it("pins the Cadence source tag", () => {
    expect(SOURCE_TAG).toBe(2606250005);
  });
});
