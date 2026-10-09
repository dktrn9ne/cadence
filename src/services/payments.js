import { Client } from "xrpl";
import { buildRlusdPayment, buildCrossmarkRlusdPayment, responseHash } from "../domain/payments.js";
import { getCrossmark } from "./wallet-connection.js";

export const submitCrossmarkRlusdPayment = async ({ account, destination, amount }) => {
  const crossmark = await getCrossmark();
  const payment = buildCrossmarkRlusdPayment({ account, destination, amount });
  const result = await crossmark.async.signAndSubmitAndWait(payment);
  return { result, hash: responseHash(result), transaction: payment };
};

export const submitXrplConnectRlusdPayment = async ({ manager, account, destination, amount }) => {
  if (!manager?.connected) {
    throw new Error("Connect an XRPL wallet first.");
  }
  const payment = buildCrossmarkRlusdPayment({ account, destination, amount });
  const result = await manager.signAndSubmit(payment);
  return { result, hash: responseHash(result), transaction: payment };
};

export const submitRlusdPayment = async ({ wallet, destination, amount }) => {
  const client = new Client("wss://s1.ripple.com");
  await client.connect();
  try {
    const transaction = buildRlusdPayment({ wallet, destination, amount });
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    return { result, hash: signed.hash, transaction };
  } finally {
    await client.disconnect();
  }
};
