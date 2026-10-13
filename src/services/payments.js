import { Client } from "xrpl";
import { buildRlusdPayment, buildCrossmarkRlusdPayment, responseHash } from "../domain/payments.js";

export const submitXrplConnectRlusdPayment = async ({ manager, account, destination, amount }) => {
  if (!manager?.connected) {
    throw new Error("Connect an XRPL wallet first.");
  }
  const payment = buildCrossmarkRlusdPayment({ account, destination, amount });
  const result = await manager.signAndSubmit(payment);
  return { result, hash: responseHash(result), transaction: payment };
};

export const submitRlusdPayment = async ({ wallet, destination, amount, onPrepared }) => {
  const client = new Client("wss://s1.ripple.com");
  let hash = null;
  let submissionStarted = false;
  try {
    await client.connect();
    const transaction = buildRlusdPayment({ wallet, destination, amount });
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    hash = signed.hash;
    // Persist only the public hash BEFORE any relay; never pass the blob.
    await onPrepared?.(hash);
    submissionStarted = true;
    const result = await client.submitAndWait(signed.tx_blob);
    return { result, hash: signed.hash, transaction };
  } catch (error) {
    // Keep the error surface public and bounded. Pre-relay failures prove
    // that nothing was submitted; a relay timeout retains its recovery hash.
    const failure = new Error(submissionStarted ? "The payment submission outcome is unknown. Reconcile with the ledger before retrying." : "Payment preparation failed before submission.");
    failure.code = submissionStarted ? "SUBMISSION_UNKNOWN" : "NOT_CONNECTED";
    failure.hash = submissionStarted ? hash : null;
    throw failure;
  } finally {
    try { await client.disconnect(); } catch { /* Cleanup must not erase the receipt/hash. */ }
  }
};
