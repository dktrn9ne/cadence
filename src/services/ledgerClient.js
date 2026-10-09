// Production tx lookup for the reconciler: one short-lived client per lookup,
// matching the per-call client pattern in services/payments.js. The endpoint
// is the repo's canonical mainnet websocket constant.
//
// The reconciler stays injected and socket-free; only this module (and the
// submitters) touch the real network. Resolves with the tx-command result —
// the validated transaction object the reconciler's identity check reads —
// and rejects with the rippled error payload on .data (txnNotFound et al.,
// which the reconciler classifies as "not final yet").
import { Client } from "xrpl";
import { XRPL_WS_URL } from "../domain/xrpl-constants.js";

export const fetchValidatedTransaction = async (hash) => {
  const client = new Client(XRPL_WS_URL);
  await client.connect();
  try {
    const response = await client.request({ command: "tx", transaction: hash });
    return response.result;
  } finally {
    await client.disconnect();
  }
};
