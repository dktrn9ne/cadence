import { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "./xrpl-constants.js";

export const buildRlusdPayment = ({ wallet, destination, amount }) => ({
  TransactionType: "Payment",
  Account: wallet.address,
  Destination: destination,
  SourceTag: SOURCE_TAG,
  Amount: {
    currency: RLUSD_CURRENCY,
    issuer: RLUSD_ISSUER,
    value: amount,
  },
});

export const buildCrossmarkRlusdPayment = ({ account, destination, amount }) =>
  buildRlusdPayment({ wallet: { address: account }, destination, amount });

export const responseHash = (response) =>
  response?.response?.data?.resp?.result?.hash ||
  response?.response?.data?.result?.hash ||
  response?.data?.resp?.result?.hash ||
  response?.data?.result?.hash ||
  response?.result?.hash ||
  response?.hash ||
  null;
