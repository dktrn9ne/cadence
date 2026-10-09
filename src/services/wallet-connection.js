export const getCrossmark = async () => {
  const module = await import("@crossmarkio/sdk");
  return module.default || module;
};
// Xaman's OAuth flow needs a developer API key; Cadence ships none. The key
// arrives (if ever) through the build environment only — absent, empty, or
// whitespace-only yields null, and the value is never logged or persisted.
// Missing key = a disabled wallet option in the UI, never an error.
export const readXamanApiKey = (env = import.meta.env) => {
  const raw = env?.VITE_XAMAN_API_KEY;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
};

export const getXrplConnect = async () => import("@textrp/xrpl-connect");

export const connectCrossmarkWallet = async () => {
  const crossmark = await getCrossmark();
  const detected = await crossmark.async.detect(2000);
  if (!detected && !crossmark.sync.isInstalled?.()) {
    throw new Error("Crossmark was not detected. Install or unlock Crossmark, then try again.");
  }
  await crossmark.async.connect(5000).catch(() => false);
  const signIn = await crossmark.async.signInAndWait();
  const address =
    signIn?.response?.data?.address ||
    signIn?.response?.data?.account ||
    signIn?.data?.address ||
    signIn?.data?.account ||
    crossmark.sync.getAddress?.();
  if (!address?.startsWith("r")) {
    throw new Error("Crossmark did not return a valid XRPL address.");
  }
  return { address, signIn };
};
