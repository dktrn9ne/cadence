import { useEffect, useMemo, useRef, useState } from "react";
import { Client, ECDSA, Wallet } from "xrpl";
import { theme } from "./brand/tokens.js";
import { CadenceLockup, CadenceMark } from "./brand/CadenceMark.jsx";
import { RLUSD_CURRENCY, RLUSD_ISSUER, SOURCE_TAG } from "./domain/xrpl-constants.js";
import { TIME_UNITS, FREQUENCIES, getSchedule, getFrequencyMs } from "./domain/schedule.js";
import { createInstallmentDispatcher } from "./services/installmentDispatcher.js";
import { flushPlans, loadPlans, savePlans } from "./storage/planState.js";
import { dispatchBlockReason, installmentId } from "./domain/installment.js";
import { countMissedWindows, hydrateRestoredPlans, mountAttemptAction } from "./domain/recovery.js";
import { OUTCOMES, lookupTransaction } from "./services/xrplLedger.js";
import {
  buildIncomeProofCsv,
  buildIncomeProofStats,
  findPayerMismatch,
  planInstallmentAction,
  resolvePayerForWallet,
  selectExcludedXrpEntries,
  selectIncomeRows,
  stampPlanPayer,
} from "./domain/incomeProof";
import { getXrplConnect } from "./services/wallet-connection.js";
import { submitRlusdPayment, submitXrplConnectRlusdPayment } from "./services/payments.js";

const LOG_STORAGE_KEY = "cadence-debug-logs-v1";
const MAX_LOGS = 500;

const ACCESS_METHODS = [
  { value: "mnemonic", label: "BIP39 mnemonic phrase", hint: "12, 15, 18, 21, or 24 words" },
  { value: "family", label: "XRPL family seed", hint: "Usually starts with s" },
];

const isLocalDesktopApp = () =>
  typeof window !== "undefined" && (
    new URLSearchParams(window.location.search).get("desktop") === "1" ||
    /Electron|CadenceDesktop/i.test(window.navigator?.userAgent || "")
  );

const MNEMONIC_DERIVATION_OPTIONS = Array.from({ length: 10 }, (_, index) => [
  {
    label: `XRPL account ${index + 1} / Ed25519`,
    options: { derivationPath: `m/44'/144'/${index}'/0/0`, algorithm: ECDSA.ed25519 },
  },
  {
    label: `XRPL account ${index + 1} / secp256k1`,
    options: { derivationPath: `m/44'/144'/${index}'/0/0`, algorithm: ECDSA.secp256k1 },
  },
]).flat();

const emptyPerson = {
  name: "",
  role: "",
  email: "",
  address: "",
  weeklyPay: "16",
  frequency: "minute",
  active: false,
};

const money = (value, digits = 2) => {
  const number = Number(value) || 0;
  return `$${number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

const tokenAmount = (value) => Math.max(0, Number(value) || 0).toFixed(6);

const shortAddress = (address) =>
  address ? `${address.slice(0, 7)}...${address.slice(-5)}` : "Not added yet";

const xrplRequest = (request) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://s1.ripple.com");
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("The XRPL balance check timed out."));
    }, 12000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: Date.now(), ...request }));
    });
    socket.addEventListener("message", (event) => {
      window.clearTimeout(timeout);
      socket.close();
      const response = JSON.parse(event.data);
      if (response.status === "error" || response.error) {
        reject(new Error(response.error_message || response.error || "XRPL request failed."));
        return;
      }
      resolve(response.result);
    });
    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Could not connect to the XRPL network."));
    });
  });

const isAccountNotFoundError = (error) =>
  /actnotfound|account not found/i.test(error?.message || String(error));

const emptyIncomeProofData = (employeeWallet, employerWallet) => ({
  employeeWallet,
  employerWallet,
  sourceTag: SOURCE_TAG,
  markerRemaining: false,
  fetchedCount: 0,
  incomeRows: [],
  stats: {
    incomeCount: 0,
    totalRlusd: 0,
    excludedCount: 0,
    totalExcludedXrp: 0,
    projectedWeekly: 0,
    projectedMonthly: 0,
    projectedAnnual: 0,
    lifetimeMatches: 0,
    observedDays: 0,
  },
});

const readIncomeProofData = async (employeeWallet, payerWallet) => {
  if (!employeeWallet?.startsWith("r")) {
    throw new Error("Enter or unlock a valid employee XRPL wallet first.");
  }
  if (!payerWallet?.startsWith("r")) {
    throw new Error("Resolve a payer wallet for this worker before reading income proof.");
  }

  let marker;
  const transactions = [];
  for (let page = 0; page < 20; page += 1) {
    let result;
    try {
      result = await xrplRequest({
        command: "account_tx",
        account: employeeWallet,
        ledger_index_min: -1,
        ledger_index_max: -1,
        binary: false,
        forward: false,
        limit: 400,
        ...(marker ? { marker } : {}),
      });
    } catch (error) {
      if (page === 0 && isAccountNotFoundError(error)) {
        return emptyIncomeProofData(employeeWallet, employerWallet);
      }
      throw error;
    }
    transactions.push(...(result.transactions || []));
    marker = result.marker;
    if (!marker) break;
  }

  const incomeRows = selectIncomeRows(transactions, { payer: payerWallet, destination: employeeWallet });
  const excludedXrpEntries = selectExcludedXrpEntries(transactions, employeeWallet);
  const stats = buildIncomeProofStats({ incomeRows, excludedXrpEntries, markerRemaining: Boolean(marker) });

  return {
    employeeWallet,
    employerWallet: payerWallet,
    sourceTag: SOURCE_TAG,
    markerRemaining: Boolean(marker),
    fetchedCount: transactions.length,
    incomeRows,
    stats,
  };
};

const normalizeMnemonic = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

const isLikelyFamilySeed = (value) => {
  const phrase = value.trim();
  return /^s[1-9A-HJ-NP-Za-km-z]{20,}$/.test(phrase) && !/\s/.test(phrase);
};

const createWalletFromInput = (method, value, expectedAddress = "") => {
  const phrase = value.trim();
  const expected = expectedAddress.trim();
  if (!phrase) {
    throw new Error("Enter your wallet phrase to continue.");
  }

  const selectedMethod = method === "auto"
    ? isLikelyFamilySeed(phrase) ? "family" : "mnemonic"
    : method;

  if (selectedMethod === "family") {
    try {
      const wallet = Wallet.fromSeed(phrase);
      if (expected && wallet.address !== expected) {
        throw new Error(`This family seed unlocks ${wallet.address}, not ${expected}. Check the wallet secret before continuing.`);
      }
      return wallet;
    } catch (error) {
      if (error?.message?.includes("not")) throw error;
      throw new Error("That does not look like a valid XRPL family seed. XRPL family seeds usually start with s.");
    }
  }

  if (isLikelyFamilySeed(phrase)) {
    throw new Error("This looks like an XRPL family seed. Choose XRPL family seed instead of BIP39 mnemonic phrase.");
  }

  const normalizedMnemonic = normalizeMnemonic(phrase);
  const wordCount = normalizedMnemonic.split(" ").filter(Boolean).length;
  if (![12, 15, 18, 21, 24].includes(wordCount)) {
    throw new Error("BIP39 mnemonic phrases are 12, 15, 18, 21, or 24 words. If your secret starts with s, use XRPL family seed.");
  }

  try {
    const candidates = MNEMONIC_DERIVATION_OPTIONS.map((item) => {
      try {
        const wallet = Wallet.fromMnemonic(normalizedMnemonic, item.options);
        return { ...item, wallet };
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (expected) {
      const match = candidates.find((item) => item.wallet.address === expected);
      if (match) return match.wallet;
      const derived = candidates.slice(0, 6).map((item) => `${item.label}: ${item.wallet.address}`).join(" | ");
      throw new Error(`This phrase did not derive ${expected}. First checked addresses: ${derived}`);
    }

    return candidates[0]?.wallet || Wallet.fromMnemonic(normalizedMnemonic);
  } catch (error) {
    if (error?.message?.includes("did not derive")) throw error;
    throw new Error("Unable to parse this as a BIP39 mnemonic. Check the spelling and word order, or use XRPL family seed if your secret starts with s.");
  }
};

const readRlusdBalance = async (address) => {
  if (!address || !address.startsWith("r")) {
    return 0;
  }

  let result;
  try {
    result = await xrplRequest({
      command: "account_lines",
      account: address,
      peer: RLUSD_ISSUER,
      ledger_index: "validated",
    });
  } catch (error) {
    if (isAccountNotFoundError(error)) return 0;
    throw error;
  }
  const line = result.lines?.find((item) =>
    (item.currency === "RLUSD" || item.currency === RLUSD_CURRENCY) && item.account === RLUSD_ISSUER
  );
  return Math.max(0, Number(line?.balance || 0));
};

const addHistoryItem = (setter, item) => {
  setter((current) => [
    {
      id: `history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      ...item,
    },
    ...current,
  ]);
};

const safeLogPayload = (value) => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.map(safeLogPayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const lower = key.toLowerCase();
    if (lower.includes("seed") || lower.includes("phrase") || lower.includes("secret") || lower.includes("password") || lower.includes("accessinput")) {
      return [key, "[redacted]"];
    }
    return [key, safeLogPayload(item)];
  }));
};

const loadStoredLogs = () => {
  try {
    return JSON.parse(window.localStorage.getItem(LOG_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
};

// Durable due-state, restored before first paint (PR 04): loadPlans parses the
// versioned envelope with safe defaults, and hydrateRestoredPlans maps it onto
// the dashboard's plan shape (destination -> address, neutral schedule
// defaults, recovered banner flag). A pure read — safe under StrictMode's
// double-invoked initializer.
const restorePlans = () => hydrateRestoredPlans(loadPlans());

function BrandPattern({ variant = "wave" }) {
  if (variant === "dots") return <div className="brand-pattern pattern-dots" aria-hidden="true" />;
  if (variant === "rings") return <div className="brand-pattern pattern-rings" aria-hidden="true" />;
  if (variant === "lines") return <div className="brand-pattern pattern-lines" aria-hidden="true" />;
  return (
    <div className="brand-pattern pattern-wave" aria-hidden="true">
      <svg viewBox="0 0 1200 118" preserveAspectRatio="none">
        <path d="M0 72 C130 92 238 92 360 66 S590 20 760 44 S1030 78 1200 46" />
        <path d="M0 62 C130 84 242 86 365 62 S594 18 762 36 S1032 70 1200 38" />
        <path d="M0 52 C132 76 246 80 370 58 S598 18 764 30 S1034 62 1200 32" />
        <path d="M0 42 C134 68 250 72 375 54 S602 20 766 26 S1036 54 1200 28" />
        <path d="M0 32 C136 58 254 64 380 50 S606 24 768 24 S1038 48 1200 28" />
        <path d="M0 22 C138 50 258 54 385 46 S610 30 770 26 S1040 44 1200 34" />
      </svg>
    </div>
  );
}

function StreamWidget({
  label,
  amount,
  subcopy,
  address,
  primaryAction,
  secondaryAction,
  stats = [],
  compact = false,
}) {
  const display = money(amount, 4);
  const [whole, cents = "0000"] = display.replace("$", "").split(".");
  return (
    <section className={`stream-widget ${compact ? "stream-widget-compact" : ""}`}>
      <div className="stream-widget-rings" aria-hidden="true" />
      <div className="stream-top">
        <div>
          <p className="stream-label">{label}</p>
          <div className="stream-amount">${whole}<span>.{cents}</span></div>
          <p className="stream-subcopy">{subcopy}</p>
        </div>
        <div className="stream-live"><span className="online-dot" />Live</div>
      </div>
      <svg className="stream-wave" viewBox="0 0 400 64" preserveAspectRatio="none" aria-hidden="true">
        <path className="stream-wave-base" d="M0,32 L400,32" />
        <path className="stream-wave-line" d="M0,32 C65,36 110,36 150,32 C178,32 182,12 195,32 C205,49 214,49 226,32 C266,28 315,34 400,32" />
        <circle cx="200" cy="32" r="4" />
      </svg>
      <div className="stream-stats">
        {stats.map((item) => (
          <div key={item.label}>
            <strong>{item.value}</strong>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      <div className="stream-footer">
        <code>{address || "No wallet connected"}</code>
        <div className="stream-actions">
          {primaryAction}
          {secondaryAction}
        </div>
      </div>
    </section>
  );
}

function Button({ children, kind = "primary", ...props }) {
  return <button className={`button button-${kind}`} {...props}>{children}</button>;
}

function Field({ label, children, help }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}

function Intro({ method, setMethod, accessInput, setAccessInput, expectedAddress, setExpectedAddress, onSubmit, error, isLocal, connectorRef, xrplManager }) {
  const [showWalletSecret, setShowWalletSecret] = useState(false);

  useEffect(() => {
    if (!isLocal && connectorRef?.current && xrplManager) {
      connectorRef.current.setWalletManager(xrplManager);
    }
  }, [connectorRef, isLocal, xrplManager]);

  return (
    <div className="center-screen intro-screen">
      <div className="intro-decoration decoration-one" />
      <div className="intro-decoration decoration-two" />
      <BrandPattern variant="wave" />
      <BrandPattern variant="dots" />
      <div className="intro-card">
        <CadenceLockup />
        <BrandPattern variant="rings" />
        <p className="eyebrow">{isLocal ? "Import wallet" : "Connect XRPL wallet"}</p>
        <h1>{isLocal ? <>Your wallet,<br /><em>imported locally.</em></> : <>Your wallet,<br /><em>exactly as selected.</em></>}</h1>
        <p className="intro-copy">
          {isLocal
            ? "Cadence unlocks the local app with a BIP39 mnemonic seed phrase or XRPL family seed, then signs payments on this device."
            : "Cadence connects through XRPL Connect so you can use supported XRP wallets including Xaman, Crossmark, GemWallet, and Xyra."}
        </p>
        <form className="intro-connect-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
          {error && <div className="error-message">{error}</div>}
          {isLocal && (
            <>
              <Field label="Wallet import type">
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  {ACCESS_METHODS.map((item) => <option value={item.value} key={item.value}>{item.label} - {item.hint}</option>)}
                </select>
              </Field>
              <Field label="Mnemonic seed phrase or family seed">
                <div className="secret-input-wrap">
                  <input
                    type={showWalletSecret ? "text" : "password"}
                    value={accessInput}
                    onChange={(event) => setAccessInput(event.target.value)}
                    placeholder="12/24 words or s..."
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <button
                    type="button"
                    className="secret-toggle"
                    onClick={() => setShowWalletSecret((showing) => !showing)}
                  >
                    {showWalletSecret ? "Hide" : "Show"}
                  </button>
                </div>
              </Field>
              <Field label="Expected public address" help="Optional. Use this to confirm the secret opens the intended r... wallet.">
                <input value={expectedAddress} onChange={(event) => setExpectedAddress(event.target.value)} placeholder="r..." autoComplete="off" spellCheck="false" />
              </Field>
            </>
          )}
          {!isLocal && (
            <xrpl-wallet-connector
              ref={connectorRef}
              class="xrpl-connector"
              wallets="xaman,crossmark,gemwallet,xyra"
              primary-wallet="xaman"
              background-color={theme.surfaceEmbed}
            />
          )}
          <Button type="submit">{isLocal ? "Import wallet" : "Connect XRPL wallet"} <span>{">"}</span></Button>
        </form>
        <div className="intro-note">
          {isLocal
            ? "The desktop app only offers mnemonic seed phrase or XRPL family seed import. Crossmark is reserved for the web version."
            : "Cadence never asks for your seed phrase in the web flow. Your connected XRPL wallet signs each transaction request."}
        </div>
      </div>
    </div>
  );
}

function FundingModal({ onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <button className="modal-close" onClick={onClose} aria-label="Close">x</button>
        <CadenceMark className="modal-icon brand-mark" />
        <p className="eyebrow">Your wallet is ready</p>
        <h2>No RLUSD yet.</h2>
        <p className="section-copy">Fund the wallet first, then Cadence can read the balance and help you plan payments.</p>
        <div className="funding-steps">
          <div><b>1</b><span>Use a trusted exchange or RLUSD onramp that supports the XRPL network.</span></div>
          <div><b>2</b><span>Copy your public XRPL address and verify the RLUSD issuer before sending.</span></div>
          <div><b>3</b><span>Come back and refresh the balance. Never share your secret phrase.</span></div>
        </div>
        <Button kind="secondary" onClick={onClose}>Go to dashboard</Button>
      </div>
    </div>
  );
}

function PersonEditor({ person, onSave, onCancel }) {
  const [draft, setDraft] = useState({ ...emptyPerson, ...(person || {}) });
  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const hourlyMode = (draft.payMode || "weekly") === "hourly";

  return (
    <form className="editor-card" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
      <div className="editor-heading">
        <div><p className="eyebrow">People</p><h3>{person?.id ? "Edit person" : "Add a person"}</h3></div>
        <button type="button" className="text-button" onClick={onCancel}>Cancel</button>
      </div>
      <div className="editor-grid">
        <Field label="Name"><input required value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="Alex Morgan" /></Field>
        <Field label="Role"><input value={draft.role} onChange={(event) => update("role", event.target.value)} placeholder="Designer" /></Field>
        <Field label="Email"><input type="email" value={draft.email} onChange={(event) => update("email", event.target.value)} placeholder="alex@example.com" /></Field>
        <Field label="Public XRPL address" help="Required only for a real payment."><input value={draft.address} onChange={(event) => update("address", event.target.value)} placeholder="r..." /></Field>
      </div>
      <div className="pay-plan-box">
        <div className="pay-plan-title">Weekly payment cadence</div>
        <label className="mode-toggle">
          <input type="checkbox" checked={hourlyMode} onChange={(event) => update("payMode", event.target.checked ? "hourly" : "weekly")} />
          <span>{hourlyMode ? "Hourly pay" : "Weekly salary"}</span>
        </label>
        <div className="editor-grid plan-grid">
          {hourlyMode ? (
            <>
              <Field label="Hourly RLUSD pay" help="Rate per hour."><div className="input-with-symbol"><span>$</span><input type="number" min="0" step="0.01" required value={draft.hourlyPay ?? "20"} onChange={(event) => update("hourlyPay", event.target.value)} /></div></Field>
              <Field label="Hours per week" help="Used to calculate weekly total."><input type="number" min="0" step="0.25" required value={draft.hoursPerWeek ?? "40"} onChange={(event) => update("hoursPerWeek", event.target.value)} /></Field>
            </>
          ) : (
            <Field label="Weekly RLUSD pay" help="The total this person should receive each week."><div className="input-with-symbol"><span>$</span><input type="number" min="0" step="0.01" required value={draft.weeklyPay ?? draft.amount ?? "16"} onChange={(event) => update("weeklyPay", event.target.value)} /></div></Field>
          )}
          <Field label="Pay frequency" help="Cadence divides the weekly total across this interval."><select value={draft.frequency} onChange={(event) => update("frequency", event.target.value)}>{FREQUENCIES.map((key) => <option key={key} value={key}>Every {TIME_UNITS[key].label}</option>)}</select></Field>
        </div>
        <ScheduleSummary person={draft} />
      </div>
      <Button type="submit">Save cadence <span>{">"}</span></Button>
    </form>
  );
}

function ScheduleSummary({ person }) {
  const schedule = getSchedule(person);
  return (
    <div className="schedule-summary">
      <div><span className="summary-label">Each payment</span><strong>{money(schedule.perPayment, 6)}</strong></div>
      <div><span className="summary-label">Payments per week</span><strong>{schedule.payments.toLocaleString()}</strong></div>
      <div><span className="summary-label">Weekly total</span><strong>{money(schedule.weeklyPay, 2)}</strong></div>
    </div>
  );
}

function PeopleList({ people, selectedId, onSelect, onAdd }) {
  return (
    <div className="people-card">
      <div className="card-heading"><div><p className="eyebrow">Your people</p><h2>{people.length ? "Payment plans" : "Start with one person"}</h2></div><Button kind="small" onClick={onAdd}>+ Add person</Button></div>
      {people.length === 0 ? (
        <div className="empty-people"><div className="empty-scribble">*</div><p>Add someone to see their payment plan here.</p><Button kind="secondary" onClick={onAdd}>Add your first person</Button></div>
      ) : (
        <div className="people-list">
          {people.map((person) => {
            const schedule = getSchedule(person);
            return <button key={person.id} className={`person-row ${selectedId === person.id ? "selected" : ""}`} onClick={() => onSelect(person.id)}>
              <span className="avatar">{person.name.slice(0, 1).toUpperCase()}</span>
              <span className="person-info"><b>{person.name}</b><small>{person.role || "Person"}</small></span>
              <span className="person-amount"><b>{money(schedule.perPayment, 4)}</b><small>every {schedule.frequencyLabel}</small></span>
              <span className={`status-dot ${person.active ? "on" : ""}`} />
            </button>;
          })}
        </div>
      )}
    </div>
  );
}

function PersonDetails({ person, onEdit, onToggle, onPay, onApproveMissed, onSkipMissed, onReconcileNow, walletReady, paymentMessage }) {
  const schedule = getSchedule(person);
  const paidCount = Number(person.paidCount || 0);
  const nextRun = person.nextRunAt ? new Date(person.nextRunAt).toLocaleString() : "Not scheduled";
  // Recovery states (PR 04): the next installment's durable attempt decides
  // what the card surfaces. A verifying (unresolved) submission takes
  // precedence over the missed-window prompt — both block dispatch; the
  // recovered banner only shows when neither is pending.
  const nextAttempt = person.attempts?.[installmentId(person.id, paidCount)];
  const verifying = nextAttempt?.status === "unresolved";
  const verifyingHash = verifying && nextAttempt.hash ? `${String(nextAttempt.hash).slice(0, 10)}...` : null;
  const missedCount = Number(person.missedCount || 0);
  const missedPending = person.catchUpPending === true && missedCount > 0 && !verifying;
  const lastFailed = nextAttempt?.status === "validated_failure";
  return (
    <div className="details-card">
      <div className="details-top"><div className="large-avatar">{person.name.slice(0, 1).toUpperCase()}</div><div><p className="eyebrow">Selected person</p><h2>{person.name}</h2><p className="muted-line">{person.role || "No role added"} {person.email ? ` ${person.email}` : ""}</p></div><button className="text-button edit-button" onClick={onEdit}>Edit</button></div>
      <div className="address-line"><span>Destination</span><code>{shortAddress(person.address)}</code></div>
      <div className="detail-highlight"><div><span className="eyebrow">Weekly pay</span><strong>{money(schedule.weeklyPay)}</strong><small>recipient amount across 1 week</small></div><div className="highlight-arrow">{">"}</div><div><span className="eyebrow">Each payout</span><strong>{money(schedule.perPayment, 6)}</strong><small>sent directly to the destination wallet</small></div></div>
      <div className="plan-meter"><div><span>Installments sent</span><strong>{paidCount} / {schedule.payments.toLocaleString()}</strong></div><div><span>Next send</span><strong>{nextRun}</strong></div><div><span>Recipient debit</span><strong>{money(schedule.totalPerPayment, 6)}</strong></div><div><span>Source tag</span><strong>{SOURCE_TAG}</strong></div><div><span>Payer</span><strong>{person.payer ? shortAddress(person.payer) : "Not attached"}</strong></div></div>
      {verifying && (
        <div className="recovery-note recovery-verifying" role="status">
          <b>Verifying installment #{paidCount + 1} with the ledger…</b>
          <span>{verifyingHash ? `Submitted as ${verifyingHash} before the app closed — outcome not yet known.` : "An earlier submission has no reconcilable hash yet."}</span>
        </div>
      )}
      {missedPending && (
        <div className="recovery-note recovery-missed" role="status">
          <b>{missedCount === 1 ? "1 installment missed while the app was closed" : `${missedCount} installments missed while the app was closed`}</b>
          <span>Approve to send installment #{paidCount + 1} through the normal wallet flow — one installment per approval.</span>
          <div className="details-actions"><Button onClick={() => onApproveMissed(person)}>Approve send</Button><Button kind="secondary" onClick={() => onSkipMissed(person)}>Skip this window</Button></div>
        </div>
      )}
      {person.recovered === true && !verifying && !missedPending && (
        <div className="recovery-note" role="status">Recovered from last session — up to date</div>
      )}
      <div className="details-actions"><Button kind={person.active ? "secondary" : "primary"} onClick={onToggle}>{person.active ? "Pause plan" : "Start plan"}</Button><Button kind="secondary" onClick={onPay} disabled={!walletReady || !person.address.startsWith("r") || verifying}>Pay one installment</Button>{verifying && <Button kind="secondary" onClick={() => onReconcileNow(person)}>Reconcile now</Button>}</div>
      {!walletReady && <p className="inline-note">Connect a wallet first to make an on-chain payment.</p>}
      {walletReady && !person.address.startsWith("r") && <p className="inline-note">Add a public XRPL destination address before paying.</p>}
      {verifying && <p className="inline-note">Paying is blocked until the ledger classifies the earlier submission — reconcile to unblock.</p>}
      {lastFailed && <p className="inline-note">The last attempt for installment #{paidCount + 1} failed and did not advance this plan — see payment activity below; retrying is a fresh decision.</p>}
      {paymentMessage && <div className="success-message">{paymentMessage}</div>}
      <div className="safe-payment-note"><span>?</span> Cadence submits one RLUSD payment per interval to the designated destination wallet. Scheduled plans continue until all weekly installments have been sent or you pause the plan.</div>
    </div>
  );
}

function IncomeVerification({ walletAddress, employee, people, onBack, onExportLogs, onReset }) {
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [proofData, setProofData] = useState(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState("");
  const connectedWallet = walletAddress?.startsWith("r") ? walletAddress : "";
  const resolution = useMemo(() => resolvePayerForWallet(connectedWallet, people), [connectedWallet, people]);
  const employerWallet = proofData?.employerWallet || resolution.payer;
  const payerSource = proofData?.payerSource || resolution.source;
  const stats = proofData?.stats || {
    incomeCount: 0,
    totalRlusd: 0,
    excludedCount: 0,
    totalExcludedXrp: 0,
    projectedWeekly: 0,
    projectedMonthly: 0,
    projectedAnnual: 0,
    lifetimeMatches: 0,
    observedDays: 0,
  };
  const incomeRows = proofData?.incomeRows || [];
  const generatedAt = new Date().toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  const documentId = connectedWallet ? `CADENCE-INC-${connectedWallet.slice(0, 6).toUpperCase()}-${connectedWallet.slice(-6).toUpperCase()}` : "CADENCE-INC-CONNECT";

  const refreshProof = async () => {
    setProofLoading(true);
    setProofError("");
    try {
      const data = await readIncomeProofData(connectedWallet, resolution.payer);
      setProofData({ ...data, payerSource: resolution.source });
    } catch (error) {
      setProofError(error?.message || "Could not read income transactions from the XRP Ledger.");
    } finally {
      setProofLoading(false);
    }
  };

  useEffect(() => {
    setProofData(null);
    refreshProof();
  }, [connectedWallet, resolution.payer]);

  const downloadCsv = () => {
    const blob = new Blob([buildIncomeProofCsv(incomeRows)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cadence-income-proof.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell proof-app">
      <header className="topbar proof-topbar">
        <CadenceLockup compact />
        <div className="topbar-right">
          <div className="wallet-chip"><span className="online-dot" />Connected wallet {shortAddress(connectedWallet)}</div>
          <Button kind="ghost" onClick={onExportLogs}>Download support file</Button>
          <Button kind="ghost" onClick={onBack}>Back to dashboard</Button>
          <Button kind="ghost" onClick={onReset}>Change wallet</Button>
        </div>
      </header>
      <main className="proof-content">
        <div className="proof-heading">
          <div>
            <p className="eyebrow"><span className="online-dot" /> Certified financial document</p>
            <h1>Income verification</h1>
            <p>On-chain proof of income, compiled from real XRP Ledger transactions for the currently connected wallet.</p>
          </div>
          <span className="proof-pill">Generated {generatedAt}</span>
        </div>

        <section className="proof-reference">
          <div className="proof-reference-top">
            <div>
              <p>Document reference</p>
              <strong>{documentId}</strong>
            </div>
            <span><i />Verified on-chain</span>
          </div>
          <div className="proof-reference-grid">
            <div><small>Connected wallet / payee</small><b>{connectedWallet || "No wallet connected"}</b></div>
            <div>
              <small>Payer</small>
              <b>{employerWallet}</b>
              <span className={`payer-source-badge ${payerSource === "plan" ? "payer-source-plan" : "payer-source-demo"}`}>
                {payerSource === "plan" ? "Payer from plan" : "Cadence demo payer"}
              </span>
            </div>
            <div><small>Source tag</small><b>{SOURCE_TAG}</b></div>
            <div><small>Ledger</small><b>XRP Ledger - Mainnet</b></div>
          </div>
        </section>

        <div className="proof-stat-grid">
          <section className="proof-card"><p className="eyebrow">Verified payments</p><strong>{stats.incomeCount}</strong><span>tagged incoming RLUSD transfers from Cadence</span></section>
          <section className="proof-card"><p className="eyebrow">RLUSD received</p><strong>${stats.totalRlusd.toFixed(6)}</strong><span>over the verified window below</span></section>
          <section className="proof-card"><p className="eyebrow">Other on-chain activity</p><strong>{stats.excludedCount}</strong><span>XRP txns ({stats.totalExcludedXrp.toFixed(6)} XRP), excluded from income</span></section>
        </div>

        {(proofLoading || proofError || stats.incomeCount === 0) && (
          <section className={`proof-status ${proofError ? "error" : ""}`}>
            {proofLoading ? "Reading real wallet transactions from XRPL mainnet..." : proofError || "No Cadence-tagged RLUSD income transactions were found for this wallet yet."}
          </section>
        )}

        <section className="proof-card proof-projection">
          <p className="eyebrow">Projected income, at verified rate</p>
          <h2>Extrapolated from {stats.incomeCount} confirmed payments</h2>
          <div className="proof-projection-grid">
            <div><small>Weekly</small><strong>${stats.projectedWeekly.toFixed(2)}</strong></div>
            <div><small>Monthly</small><strong>${stats.projectedMonthly.toFixed(2)}</strong></div>
            <div><small>Annual</small><strong>${stats.projectedAnnual.toFixed(2)}</strong></div>
          </div>
          <p>Lifetime on-chain record shows {stats.lifetimeMatches} matching incoming payments in the fetched ledger window; projections use the observed timing across {stats.observedDays.toFixed(2)} day(s) of verified data.</p>
        </section>

        <section className="proof-card proof-ledger">
          <div className="proof-ledger-head">
            <div><p className="eyebrow">Verified payment ledger</p><h2>{stats.incomeCount} employer-tagged RLUSD payments</h2></div>
            <div><Button kind="secondary" onClick={refreshProof} disabled={proofLoading}>{proofLoading ? "Reading..." : "Refresh"}</Button><Button kind="secondary" onClick={downloadCsv} disabled={!incomeRows.length}>Download CSV</Button><Button kind="ghost" onClick={() => setLedgerOpen((open) => !open)}>{ledgerOpen ? "Hide full ledger" : "View full ledger"}</Button></div>
          </div>
          {ledgerOpen && (
            <div className="employee-table-wrap">
              <table className="employee-table">
                <thead><tr><th>Time</th><th>Amount</th><th>Payer</th><th>Result</th><th>Transaction</th><th>Verify</th></tr></thead>
                <tbody>
                  {incomeRows.map((row, index) => (
                    <tr key={`${row.hash}-${row.ledgerIndex || index}`}>
                      <td>{row.time}</td>
                      <td>${row.amount.toFixed(6)}</td>
                      <td>{shortAddress(row.payer)}</td>
                      <td>{row.result}</td>
                      <td>{row.hash.slice(0, 10)}...{row.hash.slice(-6)}</td>
                      <td><a href={`https://xrpscan.com/tx/${row.hash}`} target="_blank" rel="noreferrer">xrpscan</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="proof-disclaimer">This statement reflects payments retrieved directly from the XRP Ledger for the payee wallet above, filtered to transfers carrying Cadence's source tag from its disbursing wallet. Generated for self-serve verification purposes; not a bank-issued statement.</p>
      </main>
    </div>
  );
}

function EmployeeDashboard({ walletAddress, rlusdBalance, balanceLoading, onRefreshBalance, people, onBack, onExportLogs, onReset }) {
  const connectedWallet = walletAddress?.startsWith("r") ? walletAddress : "";
  const resolution = useMemo(() => resolvePayerForWallet(connectedWallet, people), [connectedWallet, people]);
  const samplePerson = {
    name: "Connected wallet",
    role: "Employee",
    address: walletAddress,
    weeklyPay: "0",
    frequency: "seconds15",
    paidCount: 0,
  };
  const employee = people.find((person) => person.active) || people[0] || samplePerson;
  const schedule = getSchedule({ ...employee, frequency: employee.frequency || "seconds15" });
  const [withdrawn, setWithdrawn] = useState(false);
  const [employeeView, setEmployeeView] = useState("dashboard");
  const [employeeProofData, setEmployeeProofData] = useState(null);
  const [employeeProofLoading, setEmployeeProofLoading] = useState(false);
  const [employeeProofError, setEmployeeProofError] = useState("");

  useEffect(() => {
    setWithdrawn(false);
  }, [employee.id]);

  useEffect(() => {
    let cancelled = false;
    const refreshEmployeeProof = async () => {
      if (!connectedWallet) {
        setEmployeeProofData(null);
        setEmployeeProofError("Connect a wallet to read employee dashboard data.");
        return;
      }
      setEmployeeProofLoading(true);
      setEmployeeProofError("");
      setEmployeeProofData(null);
      try {
        const data = await readIncomeProofData(connectedWallet, resolution.payer);
        if (!cancelled) setEmployeeProofData({ ...data, payerSource: resolution.source });
      } catch (error) {
        if (!cancelled) setEmployeeProofError(error?.message || "Could not read employee wallet transactions.");
      } finally {
        if (!cancelled) setEmployeeProofLoading(false);
      }
    };

    refreshEmployeeProof();
    return () => {
      cancelled = true;
    };
  }, [connectedWallet, resolution.payer]);

  const incomeRows = employeeProofData?.incomeRows || [];
  const newestPayment = incomeRows[0] || null;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const verifiedLastSevenDays = incomeRows
    .filter((row) => new Date(row.iso).getTime() >= sevenDaysAgo)
    .reduce((sum, row) => sum + row.amount, 0);
  const expectedWeekly = schedule.weeklyPay > 0 ? schedule.weeklyPay : verifiedLastSevenDays;
  const progressPct = expectedWeekly > 0 ? Math.min(100, (verifiedLastSevenDays / expectedWeekly) * 100) : 0;
  const displayBalance = money(rlusdBalance, 2);
  const [balanceWhole, balanceCents = "00"] = displayBalance.replace("$", "").split(".");
  const employeeName = employee.name || "Connected wallet";
  const paidByPayer = employeeProofData?.employerWallet || resolution.payer;

  if (employeeView === "proof") {
    return <IncomeVerification walletAddress={walletAddress} employee={employee} people={people} onBack={() => setEmployeeView("dashboard")} onExportLogs={onExportLogs} onReset={onReset} />;
  }

  return (
    <div className="app-shell employee-app">
      <BrandPattern variant="wave" />
      <BrandPattern variant="dots" />
      <header className="topbar">
        <CadenceLockup compact />
        <div className="topbar-right">
          <div className="wallet-chip"><span className="online-dot" />{shortAddress(walletAddress || employee.address)}</div>
          <Button kind="ghost" onClick={onBack}>Employer dashboard</Button>
          <Button kind="ghost" onClick={() => setEmployeeView("proof")}>Income proof</Button>
          <Button kind="ghost" onClick={onExportLogs}>Support file</Button>
          <Button kind="ghost" onClick={onReset}>Change wallet</Button>
        </div>
      </header>
      <main className="dashboard-content employee-content">
        <div className="employee-hero">
          <div>
            <p className="eyebrow"><span className="online-dot" /> Good to see you, {employeeName}</p>
            <h1>Your pay, streaming in</h1>
            <p className="muted-line">Real RLUSD balance and Cadence-tagged income for the currently connected wallet.</p>
          </div>
          <div className="live-pill"><span className="online-dot" />Employee dashboard</div>
        </div>

        <StreamWidget
          label="Available balance RLUSD"
          amount={rlusdBalance}
          subcopy={balanceLoading ? "Reading XRPL balance..." : `Read from ${shortAddress(connectedWallet)} on XRPL mainnet`}
          address={connectedWallet}
          stats={[
            { value: money(verifiedLastSevenDays, 2), label: "7 day income" },
            { value: newestPayment ? money(newestPayment.amount, 4) : "$0.0000", label: "Latest payment" },
            { value: `${incomeRows.length}`, label: "Verified txns" },
          ]}
          primaryAction={<Button kind="secondary" onClick={onRefreshBalance} disabled={balanceLoading}>{balanceLoading ? "Reading..." : "Refresh balance"}</Button>}
          secondaryAction={<Button kind="soft" onClick={() => setWithdrawn(true)} disabled={withdrawn}>{withdrawn ? "Withdrawal queued" : "Withdraw"}</Button>}
        />
        {withdrawn && <p className="inline-note">Funds settle in your linked account shortly.</p>}

        <div className="employee-stat-grid">
          <section className="employee-card">
            <p className="eyebrow">Verified last 7 days</p>
            <strong>{money(verifiedLastSevenDays)}</strong>
            <span>{employeeProofLoading ? "Reading Cadence-tagged payments..." : `from ${incomeRows.length.toLocaleString()} fetched income payment(s)`}</span>
            <div className="employee-progress"><div style={{ width: `${progressPct}%` }} /></div>
            <small>{expectedWeekly > 0 ? `${money(verifiedLastSevenDays)} / ${money(expectedWeekly)} reference weekly amount` : "No weekly reference amount yet"}</small>
          </section>
          <section className="employee-card">
            <p className="eyebrow">Latest verified payment</p>
            <strong>{newestPayment ? money(newestPayment.amount, 6) : "$0.000000"}</strong>
            <span>{newestPayment ? newestPayment.time : employeeProofError || "No Cadence-tagged RLUSD payment found"}</span>
            <div className="employee-meta-row">
              <div><small>Source tag</small><b>{SOURCE_TAG}</b></div>
              <div><small>Paid by</small><b>{shortAddress(paidByPayer)}</b></div>
            </div>
          </section>
        </div>

        <section className="employee-card employee-history-card">
          <div className="card-heading">
            <div><p className="eyebrow">Payment history</p><h2>Recent RLUSD received</h2></div>
            <div className="card-actions"><span className="employee-live-tag">{incomeRows.slice(0, 8).length} shown</span><Button kind="secondary" onClick={() => setEmployeeView("proof")}>Open income proof</Button></div>
          </div>
          <div className="employee-table-wrap">
            <table className="employee-table">
              <thead><tr><th>Time</th><th>Amount</th><th>Transaction</th><th>Status</th></tr></thead>
              <tbody>
                {incomeRows.slice(0, 8).map((row, index) => (
                  <tr key={`${row.hash}-${row.ledgerIndex || index}`}>
                    <td>{row.time}</td>
                    <td>${row.amount.toFixed(6)}</td>
                    <td>{row.hash.slice(0, 10)}...{row.hash.slice(-6)}</td>
                    <td><span>Verified</span></td>
                  </tr>
                ))}
                {!incomeRows.length && (
                  <tr><td colSpan="4">{employeeProofLoading ? "Reading XRPL payment history..." : employeeProofError || "No Cadence-tagged RLUSD payments found for this connected wallet."}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Dashboard({ walletAddress, walletProvider, rlusdBalance, balanceLoading, onRefreshBalance, onOpenFunding, onReset, people, onAdd, selectedId, onSelect, onSave, onEdit, onToggle, onPay, onApproveMissed, onSkipMissed, onReconcileNow, paymentMessage, history, onExportLogs, onOpenEmployee }) {
  const selectedPerson = people.find((person) => person.id === selectedId);
  const walletReady = Boolean((walletProvider === "xrplconnect" || walletProvider === "local") && walletAddress?.startsWith("r"));
  const providerLabel = walletProvider === "xrplconnect" ? "XRPL wallet" : "Local wallet";
  const signingCopy = walletProvider === "xrplconnect"
    ? "Create payment plans, review each destination, and confirm each transaction in the connected XRPL wallet."
    : "Create payment plans, review each destination, and sign each transaction with the imported local wallet.";
  const payerCopy = walletProvider === "xrplconnect"
    ? "This is the active XRPL Connect wallet. Cadence never stores a seed phrase."
    : "This wallet was imported from a mnemonic seed phrase or XRPL family seed for local signing.";
  return (
    <div className="app-shell">
      <BrandPattern variant="wave" />
      <BrandPattern variant="rings" />
      <header className="topbar"><CadenceLockup compact /><div className="topbar-right"><div className="wallet-chip"><span className="online-dot" />{shortAddress(walletAddress)}</div><Button kind="ghost" onClick={onOpenEmployee}>Employee dashboard</Button><Button kind="ghost" onClick={onExportLogs}>Support file</Button><Button kind="ghost" onClick={onReset}>Change wallet</Button></div></header>
      <main className="dashboard-content">
        <div className="welcome-row"><div><p className="eyebrow">Employer dashboard</p><h1>Send RLUSD with confidence</h1><p className="muted-line">{signingCopy}</p></div><div className="live-pill"><span className="online-dot" />{providerLabel} connected</div></div>
        <StreamWidget
          label="Employer wallet balance"
          amount={rlusdBalance}
          subcopy={balanceLoading ? "Reading XRPL balance..." : signingCopy}
          address={walletAddress ? shortAddress(walletAddress) : "No wallet connected"}
          stats={[
            { value: people.length.toLocaleString(), label: "Payment plans" },
            { value: selectedPerson ? money(getSchedule(selectedPerson).perPayment, 4) : "$0.0000", label: "Next payout" },
            { value: SOURCE_TAG, label: "Source tag" },
          ]}
          primaryAction={<Button kind="secondary" onClick={onRefreshBalance} disabled={balanceLoading}>{balanceLoading ? "Reading..." : "Refresh balance"}</Button>}
          secondaryAction={rlusdBalance <= 0 ? <Button kind="soft" onClick={onOpenFunding}>Add RLUSD</Button> : null}
        />
        <section className="payer-strip"><div><p className="eyebrow">Payment wallet</p><strong>{shortAddress(walletAddress)}</strong><span>{payerCopy}</span></div><Button kind="secondary" onClick={onReset}>Change wallet</Button></section>
        <div className="content-grid"><PeopleList people={people} selectedId={selectedId} onSelect={onSelect} onAdd={onAdd} />{selectedPerson ? <PersonDetails person={selectedPerson} onEdit={() => onEdit(selectedPerson)} onToggle={() => onToggle(selectedPerson.id)} onPay={() => onPay(selectedPerson)} onApproveMissed={onApproveMissed} onSkipMissed={onSkipMissed} onReconcileNow={onReconcileNow} walletReady={walletReady} paymentMessage={paymentMessage} /> : <div className="details-card details-empty"><div className="empty-sun">*</div><h2>Add a recipient to begin.</h2><p>Create a payment plan with a verified XRPL destination address before sending RLUSD.</p><Button onClick={onAdd}>Create payment plan</Button></div>}</div>
        <section className="history-panel"><div className="card-heading"><div><p className="eyebrow">Payment activity</p><h2>Recent actions</h2></div><Button kind="small" onClick={onExportLogs}>Download support file</Button></div>{history.length === 0 ? <p className="muted-line">No payment activity yet.</p> : <div className="history-list">{history.slice(0, 8).map((item) => <div className={`history-row ${item.status}`} key={item.id}><div><b>{item.title}</b><span>{item.detail}</span></div><time>{new Date(item.at).toLocaleString()}</time></div>)}</div>}</section>
        <p className="footer-note">RLUSD is a dollar-denominated token on the XRP Ledger. Network fees, issuer details, and wallet confirmations should always be checked before sending.</p>
      </main>
    </div>
  );
}

export default function CadenceDashboard() {
  const [screen, setScreen] = useState("intro");
  const [method, setMethod] = useState("mnemonic");
  const [accessInput, setAccessInput] = useState("");
  const [expectedAddress, setExpectedAddress] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [rlusdBalance, setRlusdBalance] = useState(0);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [showFunding, setShowFunding] = useState(false);
  const [signingWallet, setSigningWallet] = useState(null);
  const [walletProvider, setWalletProvider] = useState("");
  const [people, setPeople] = useState(restorePlans);
  const [selectedId, setSelectedId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState(null);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [history, setHistory] = useState([]);
  const [debugLogs, setDebugLogs] = useState(loadStoredLogs);
  const [dashboardView, setDashboardView] = useState("employer");
  // Single-writer state mirror: every plan mutation flows through the ref so
  // async dispatch continuations always read fresh due-state (the `people`
  // state alone goes stale between a commit and a later continuation).
  // Initialized from the restored state so recovery and dispatch read what
  // was persisted, not an empty array.
  const peopleRef = useRef(null);
  if (peopleRef.current === null) peopleRef.current = people;
  const startTimerRef = useRef(null);
  const xrplConnectorRef = useRef(null);
  const xrplConnectManagerRef = useRef(null);
  const [xrplConnectManager, setXrplConnectManager] = useState(null);
  const localDesktop = useMemo(() => isLocalDesktopApp(), []);

  const commitPlans = (next) => {
    peopleRef.current = next;
    setPeople(next);
  };
  const updatePeople = (updater) => commitPlans(updater(peopleRef.current));
  const clearStartTimer = () => {
    if (startTimerRef.current !== null) {
      window.clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
  };

  // Durable due-state: every plans change is persisted (debounced); attempt
  // records persist immediately via recordAttempt inside the dispatcher, so a
  // submitted hash survives the reload it exists to be reconciled after.
  useEffect(() => {
    savePlans(peopleRef.current);
  }, [people]);
  useEffect(() => {
    const flush = () => flushPlans();
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flushPlans();
      clearStartTimer();
    };
  }, []);

  const selectedPerson = useMemo(() => people.find((person) => person.id === selectedId), [people, selectedId]);

  const logEvent = (event, payload = {}) => {
    const entry = {
      id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      event,
      payload: safeLogPayload(payload),
    };
    setDebugLogs((current) => {
      const next = [entry, ...current].slice(0, MAX_LOGS);
      window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    console.info(`[Cadence] ${event}`, entry.payload);
    return entry;
  };

  const exportLogs = () => {
    const logText = JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: "Cadence",
      sourceTag: SOURCE_TAG,
      logs: debugLogs,
      people: people.map((person) => ({
        id: person.id,
        name: person.name,
        address: person.address ? shortAddress(person.address) : "",
        active: person.active,
        schedule: getSchedule(person),
        paidCount: person.paidCount || 0,
        nextRunAt: person.nextRunAt || null,
      })),
    }, null, 2);
    const blob = new Blob([logText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cadence-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    logEvent("logs.exported", { count: debugLogs.length });
  };

  const clearLogs = () => {
    window.localStorage.removeItem(LOG_STORAGE_KEY);
    setDebugLogs([]);
    console.info("[Cadence] logs.cleared");
  };

  const refreshBalance = async (address = walletAddress, options = {}) => {
    const showFundingWhenEmpty = options.showFundingWhenEmpty ?? true;
    logEvent("balance.refresh.started", { address: address ? shortAddress(address) : "none" });
    if (!address || !address.startsWith("r")) {
      setRlusdBalance(0);
      if (showFundingWhenEmpty) setShowFunding(true);
      logEvent("balance.refresh.skipped", { reason: "missing_or_invalid_public_address" });
      return;
    }
    setBalanceLoading(true);
    try {
      const balance = await readRlusdBalance(address);
      setRlusdBalance(balance);
      if (balance <= 0 && showFundingWhenEmpty) setShowFunding(true);
      logEvent("balance.refresh.success", { address: shortAddress(address), balance });
    } catch (error) {
      setSetupError(error?.message || "Could not read the RLUSD balance.");
      logEvent("balance.refresh.failed", { error });
    } finally {
      setBalanceLoading(false);
    }
  };

  const handleConnectedXrplAccount = async (account, walletId = "xrplconnect") => {
    if (!account?.address?.startsWith("r")) {
      throw new Error("XRPL Connect did not return a valid XRPL address.");
    }
    setSetupError("");
    setSigningWallet(null);
    setWalletProvider("xrplconnect");
    setWalletAddress(account.address);
    setDashboardView("employer");
    setScreen("dashboard");
    logEvent("wallet.setup.success", {
      method: "xrplconnect",
      walletId,
      walletAddress: shortAddress(account.address),
    });
    await refreshBalance(account.address, { showFundingWhenEmpty: false });
  };

  const ensureXrplConnectManager = async () => {
    if (xrplConnectManagerRef.current) {
      return xrplConnectManagerRef.current;
    }

    const {
      WalletManager,
      XamanAdapter,
      CrossmarkAdapter,
      GemWalletAdapter,
      XyraAdapter,
    } = await getXrplConnect();

    const manager = new WalletManager({
      adapters: [
        new XamanAdapter(),
        new CrossmarkAdapter(),
        new GemWalletAdapter(),
        new XyraAdapter(),
      ],
      network: "mainnet",
      autoConnect: false,
    });

    manager.on("connect", (account) => {
      handleConnectedXrplAccount(account, manager.wallet?.id || "xrplconnect").catch((error) => {
        setSetupError(error?.message || "Could not connect XRPL wallet.");
        logEvent("wallet.setup.failed", { method: "xrplconnect", error });
      });
    });

    manager.on("accountChanged", (account) => {
      handleConnectedXrplAccount(account, manager.wallet?.id || "xrplconnect").catch((error) => {
        setSetupError(error?.message || "Could not update XRPL wallet.");
        logEvent("wallet.account_changed.failed", { method: "xrplconnect", error });
      });
    });

    manager.on("disconnect", () => {
      resetWallet();
    });

    xrplConnectManagerRef.current = manager;
    setXrplConnectManager(manager);
    return manager;
  };

  const finishSetup = async () => {
    logEvent("wallet.setup.submitted", {
      method: localDesktop ? method : "xrplconnect",
      accessLength: localDesktop ? accessInput.trim().length : 0,
      runtime: localDesktop ? "desktop" : "web",
    });

    try {
      if (localDesktop) {
        const wallet = createWalletFromInput(method, accessInput, expectedAddress);
        setSetupError("");
        setSigningWallet(wallet);
        setWalletProvider("local");
        setWalletAddress(wallet.address);
        setDashboardView("employer");
        setScreen("dashboard");
        logEvent("wallet.setup.success", { method, runtime: "desktop", walletAddress: shortAddress(wallet.address) });
        await refreshBalance(wallet.address, { showFundingWhenEmpty: false });
        return;
      }

      const manager = await ensureXrplConnectManager();
      if (manager.connected && manager.account?.address) {
        await handleConnectedXrplAccount(manager.account, manager.wallet?.id || "xrplconnect");
        return;
      }
      const connector = xrplConnectorRef.current;
      if (!connector) {
        throw new Error("XRPL Connect is still loading. Try again in a moment.");
      }
      connector.setWalletManager(manager);
      await connector.open();
    } catch (error) {
      setSigningWallet(null);
      setWalletProvider("");
      setSetupError(error?.message || (localDesktop ? "Could not import wallet." : "Could not connect XRPL wallet."));
      logEvent("wallet.setup.failed", { method: localDesktop ? method : "xrplconnect", runtime: localDesktop ? "desktop" : "web", error });
    }
  };

  const savePerson = (draft) => {
    const next = { ...stampPlanPayer(draft, walletAddress), payMode: draft.payMode || "weekly", weeklyPay: draft.weeklyPay ?? draft.amount ?? "16", hourlyPay: draft.hourlyPay ?? "20", hoursPerWeek: draft.hoursPerWeek ?? "40", id: draft.id || `person-${Date.now()}`, paidCount: draft.paidCount || 0, nextRunAt: draft.nextRunAt || null };
    const schedule = getSchedule(next);
    updatePeople((current) => draft.id ? current.map((person) => person.id === draft.id ? next : person) : [...current, next]);
    setSelectedId(next.id);
    setEditorOpen(false);
    setEditingPerson(null);
    setPaymentMessage("");
    addHistoryItem(setHistory, { status: "success", title: draft.id ? "Person updated" : "Person added", detail: `${next.name} - ${money(getSchedule(next).weeklyPay, 2)} weekly total, paid every ${getSchedule(next).frequencyLabel}` });
    logEvent(draft.id ? "person.updated" : "person.added", {
      id: next.id,
      name: next.name,
      address: next.address ? shortAddress(next.address) : "none",
      payer: next.payer ? shortAddress(next.payer) : "none",
      payMode: next.payMode,
      weeklyPay: schedule.weeklyPay,
      perPayment: schedule.perPayment,
      frequency: schedule.frequencyLabel,
      paymentsPerWeek: schedule.payments,
    });
  };

  const togglePlan = (id) => {
    const person = people.find((item) => item.id === id);
    if (!person) return;

    if (person.active) {
      // Pausing cancels a queued start-plan payment — a pause must stop new
      // dispatches, including one waiting in the start-timer window.
      clearStartTimer();
      updatePeople((current) => current.map((item) => item.id === id ? { ...item, active: false, nextRunAt: null } : item));
      setPaymentMessage(`${person.name}'s plan is paused.`);
      addHistoryItem(setHistory, { status: "paused", title: "Plan paused", detail: person.name });
      logEvent("plan.paused", { id: person.id, name: person.name });
      return;
    }

    const payerMismatch = findPayerMismatch(person, walletAddress);
    if (payerMismatch) {
      // Starting a payer-bound plan from a different wallet is blocked before any
      // transaction is queued — fresh authorization from the stored payer is required.
      updatePeople((current) => current.map((item) => item.id === id ? { ...item, active: false, nextRunAt: null } : item));
      setPaymentMessage(`${person.name}'s plan is authorized for payer ${shortAddress(payerMismatch.expectedPayer)}, but a different wallet is connected. Reconnect the payer wallet to resume — fresh authorization is required.`);
      addHistoryItem(setHistory, { status: "paused", title: "Payer mismatch", detail: `${person.name} - expected ${shortAddress(payerMismatch.expectedPayer)}, connected ${payerMismatch.connectedPayer ? shortAddress(payerMismatch.connectedPayer) : "none"}` });
      logEvent("payment.blocked.payer_mismatch", { personId: person.id, name: person.name, expected: shortAddress(payerMismatch.expectedPayer), connected: payerMismatch.connectedPayer ? shortAddress(payerMismatch.connectedPayer) : "none", source: "plan_start" });
      return;
    }

    const ready = Boolean((walletProvider === "xrplconnect" || signingWallet) && person.address?.startsWith("r"));
    updatePeople((current) => current.map((item) => item.id === id ? { ...item, active: true, nextRunAt: ready ? Date.now() : null } : item));
    setPaymentMessage(ready ? `${person.name}'s plan started. First payment prompt is opening.` : `${person.name}'s plan started. Connect a wallet and add a destination address to send payments.`);
    addHistoryItem(setHistory, { status: ready ? "success" : "waiting", title: "Plan started", detail: ready ? `${person.name} - first payment queued now` : `${person.name} - waiting for payer wallet and destination` });
    logEvent("plan.started", {
      id: person.id,
      name: person.name,
      ready,
      hasSigningWallet: Boolean(walletProvider === "xrplconnect" || signingWallet),
      hasDestination: Boolean(person.address?.startsWith("r")),
      schedule: getSchedule(person),
    });
    if (ready) {
      // The start-plan payment is a user-initiated action: it is dispatched as
      // `source: "manual"` through the same guarded door as the button, from a
      // stored, cancellable timer — pausing, resetting the wallet, or unmount
      // cancels it (never an un-cancellable bare timeout).
      startTimerRef.current = window.setTimeout(() => {
        startTimerRef.current = null;
        void payInstallment({ ...person, active: true, nextRunAt: Date.now() }, "manual");
      }, 150);
    }
  };

  // The guarded per-installment door (PR 04): one dispatcher per render,
  // wired to the single-writer plans mirror and the existing submitter
  // selection. Claims live in a ref, so the one-attempt-per-installment lock
  // survives every re-render for the life of the mount.
  const dispatchClaimsRef = useRef(new Set());
  const { dispatchInstallment } = createInstallmentDispatcher({
    getPlans: () => peopleRef.current,
    setPlans: commitPlans,
    submit: (plan, amount) => {
      const submitter = walletProvider === "xrplconnect" ? submitXrplConnectRlusdPayment : submitRlusdPayment;
      return walletProvider === "xrplconnect"
        ? submitter({ manager: xrplConnectManagerRef.current, account: walletAddress, destination: plan.address, amount })
        : submitter({ wallet: signingWallet, destination: plan.address, amount });
    },
    claims: dispatchClaimsRef.current,
  });

  const payInstallment = async (person, source = "manual") => {
    try {
      const schedule = getSchedule(person);
      const paidCount = Number(person.paidCount || 0);
      logEvent("payment.installment.requested", {
        source,
        personId: person.id,
        name: person.name,
        paidCount,
        plannedPayments: schedule.payments,
        perPayment: schedule.perPayment,
        sourceTag: SOURCE_TAG,
        payer: walletAddress ? shortAddress(walletAddress) : "none",
        destination: person.address ? shortAddress(person.address) : "none",
      });

      if (paidCount >= schedule.payments) {
        updatePeople((current) => current.map((item) => item.id === person.id ? { ...item, active: false, nextRunAt: null } : item));
        addHistoryItem(setHistory, { status: "success", title: "Plan complete", detail: `${person.name} has received all planned installments.` });
        logEvent("payment.installment.skipped", { reason: "plan_complete", personId: person.id, name: person.name });
        return { dispatched: false, reason: "plan-complete" };
      }

      // Payer guard (payment-safety rule): decide everything BEFORE any attempt
      // record or transaction exists — a payer-bound plan must never be paid
      // from another wallet, and a mismatch never leaves an attempt behind.
      const decision = planInstallmentAction(person, {
        connectedWallet: walletAddress,
        hasSigningWallet: Boolean(walletProvider === "xrplconnect" || signingWallet),
        paidCount,
        plannedPayments: schedule.payments,
      });
      if (decision.action === "payer_mismatch") {
        updatePeople((current) => current.map((item) => item.id === person.id ? { ...item, active: false, nextRunAt: null } : item));
        setPaymentMessage(`${person.name}'s plan is authorized for payer ${shortAddress(decision.expectedPayer)}, but a different wallet is connected. Reconnect the payer wallet to resume — fresh authorization is required.`);
        addHistoryItem(setHistory, { status: "paused", title: "Payer mismatch", detail: `${person.name} - expected ${shortAddress(decision.expectedPayer)}, connected ${decision.connectedPayer ? shortAddress(decision.connectedPayer) : "none"}` });
        logEvent("payment.blocked.payer_mismatch", { personId: person.id, name: person.name, expected: shortAddress(decision.expectedPayer), connected: decision.connectedPayer ? shortAddress(decision.connectedPayer) : "none", source });
        return { dispatched: false, reason: "payer-mismatch" };
      }
      if (decision.action === "missing_wallet_or_destination") {
        setPaymentMessage(`${person.name} needs a connected wallet and destination address.`);
        addHistoryItem(setHistory, { status: "waiting", title: "Payment waiting", detail: `${person.name} needs a connected wallet and destination address.` });
        logEvent("payment.installment.blocked", {
          reason: "missing_wallet_or_destination",
          hasSigningWallet: Boolean(walletProvider === "xrplconnect" || signingWallet),
          hasDestination: Boolean(person.address?.startsWith("r")),
        });
        return { dispatched: false, reason: "missing-wallet-or-destination" };
      }

      setPaymentMessage(walletProvider === "xrplconnect" ? "Confirm the installment in your XRPL wallet..." : "Signing and submitting the installment from the connected wallet...");
      addHistoryItem(setHistory, { status: "waiting", title: source === "manual" ? "Manual payment started" : "Scheduled payment started", detail: `${person.name} - ${money(schedule.perPayment, 4)} - source tag ${SOURCE_TAG}` });
      logEvent("payment.local_signing.started", {
        transactionType: "Payment",
        account: shortAddress(walletAddress),
        destination: shortAddress(person.address),
        sourceTag: SOURCE_TAG,
        amount: tokenAmount(schedule.perPayment),
        issuer: RLUSD_ISSUER,
      });

      const result = await dispatchInstallment(person, paidCount, source, { amount: tokenAmount(schedule.perPayment) });
      return reportDispatchResult(person, source, result, schedule);
    } catch (error) {
      // The door classifies its own failures; reaching here is a defect in the
      // dispatch wiring itself. Log it — never swallow.
      logEvent("payment.dispatch.failed", { personId: person.id, name: person.name, source, error: safeLogPayload(error) });
      setPaymentMessage(error?.message || "Payment could not be dispatched.");
      return { dispatched: false, reason: "dispatch-error" };
    }
  };

  // UI surfacing for the door's outcomes — messages, history, and logs live
  // here; every safety decision lives in the dispatcher.
  const reportDispatchResult = (person, source, result, schedule) => {
    if (!result.dispatched) {
      switch (result.reason) {
        case "already-in-flight":
          logEvent("payment.blocked.attempt_active", { personId: person.id, name: person.name, source });
          if (source === "manual") {
            setPaymentMessage(`${person.name}'s installment is already in flight — wait for the active attempt to resolve before retrying.`);
            addHistoryItem(setHistory, { status: "waiting", title: "Installment locked", detail: `${person.name} - an attempt for this installment is already in flight.` });
          }
          break;
        case "plan-paused":
          logEvent("payment.blocked.plan_paused", { personId: person.id, name: person.name, source });
          if (source === "manual") {
            setPaymentMessage(`${person.name}'s plan is paused — start the plan to send installments.`);
            addHistoryItem(setHistory, { status: "paused", title: "Payment blocked", detail: `${person.name} - the plan is paused; start it to send installments.` });
          }
          break;
        case "needs-approval":
          logEvent("payment.blocked.needs_approval", { personId: person.id, name: person.name, source });
          if (source === "manual") {
            setPaymentMessage(`${person.name} has a missed installment awaiting your approval — approve or skip it before sending.`);
            addHistoryItem(setHistory, { status: "waiting", title: "Approval needed", detail: `${person.name} - a missed installment waits for explicit approval.` });
          }
          break;
        case "unresolved-attempt":
          logEvent("payment.blocked.unresolved", { personId: person.id, name: person.name, source });
          if (source === "manual") {
            setPaymentMessage(`${person.name}'s earlier submission is still being verified with the ledger — it must be reconciled before another attempt.`);
            addHistoryItem(setHistory, { status: "waiting", title: "Verifying with ledger", detail: `${person.name} - an earlier submission for this installment is unclassified.` });
          }
          break;
        case "already-validated":
          logEvent("payment.blocked.already_validated", { personId: person.id, name: person.name, source });
          if (source === "manual") {
            setPaymentMessage(`${person.name}'s installment was already validated on the ledger.`);
            addHistoryItem(setHistory, { status: "success", title: "Already validated", detail: `${person.name} - this installment is already validated; progress reflects it.` });
          }
          break;
        case "plan-complete":
          addHistoryItem(setHistory, { status: "success", title: "Plan complete", detail: `${person.name} has received all planned installments.` });
          logEvent("payment.installment.skipped", { reason: "plan_complete", personId: person.id, name: person.name });
          break;
        default:
          logEvent("payment.blocked.unknown", { personId: person.id, name: person.name, source, reason: result.reason });
      }
      return result;
    }

    const txHash = result.hash;
    const complete = Boolean(result.complete);
    if (result.outcome === "validated_success") {
      setPaymentMessage(txHash ? `Payment submitted: ${txHash.slice(0, 10)}...` : "Payment submitted.");
      addHistoryItem(setHistory, { status: "success", title: complete ? "Final payment submitted" : "Payment submitted", detail: txHash ? `${person.name} - ${money(schedule.perPayment, 4)} - tag ${SOURCE_TAG} - ${txHash}` : `${person.name} - ${money(schedule.perPayment, 4)} - tag ${SOURCE_TAG}` });
      logEvent("payment.submitted", {
        personId: person.id,
        name: person.name,
        hash: txHash || null,
        nextPaidCount: result.nextPaidCount,
        complete,
        nextRunAt: complete ? null : Date.now() + getFrequencyMs(person),
      });
      return result;
    }
    if (result.outcome === "unresolved") {
      setPaymentMessage(`Submitted as ${txHash.slice(0, 10)}... before the outcome was known — Cadence is verifying it with the ledger.`);
      addHistoryItem(setHistory, { status: "waiting", title: "Verifying with ledger", detail: `${person.name} - ${money(schedule.perPayment, 4)} - ${txHash} - outcome not yet known` });
      logEvent("payment.unresolved", { personId: person.id, name: person.name, hash: txHash, source });
      return result;
    }
    // validated_failure — a failed attempt: surfaced, never advanced, never
    // silently retried. Retry is a fresh, user-initiated attempt.
    const reason = result.failureReason || result.error?.message || "The payment could not be completed.";
    setPaymentMessage(reason);
    addHistoryItem(setHistory, { status: "failed", title: "Payment not submitted", detail: `${person.name} - ${reason}` });
    logEvent("payment.failed", { personId: person.id, name: person.name, source, error: safeLogPayload(result.error) });
    return result;
  };

  // --- Mount recovery (PR 04 wave 4): restore -> reconcile -> assess -------
  //
  // Restored plans land in state before first paint (the useState initializer
  // above). This section finishes the story in the spec's strict order:
  // every unresolved attempt is classified by a ledger lookup BEFORE anything
  // can dispatch, then missed windows are counted and surfaced for explicit
  // approval. Nothing here dispatches — the only submit path is the guarded
  // door, and the durable attempt guard blocks unresolved installments even
  // while recovery is still in flight.
  const recoveryInFlightRef = useRef(false);
  const reconcilingKeysRef = useRef(new Set());

  // One keyed classification write: the attempt record lands under its
  // deterministic installment id, and a reconciled SUCCESS advances the plan
  // exactly once (only when the settled attempt is still the plan's current
  // installment — the same guard the dispatcher's advance uses).
  const settleRecoveredAttempt = (planId, key, attempt, { advance = false } = {}) => {
    updatePeople((current) => current.map((item) => {
      if (item.id !== planId) return item;
      const nextAttempts = { ...(item.attempts || {}), [key]: attempt };
      if (!advance) return { ...item, attempts: nextAttempts };
      const paidCount = Number(item.paidCount || 0);
      if (paidCount !== attempt.sequence) return { ...item, attempts: nextAttempts };
      const nextPaidCount = paidCount + 1;
      const complete = nextPaidCount >= getSchedule(item).payments;
      const nextMissed = Math.max(0, Number(item.missedCount || 0) - 1);
      return {
        ...item,
        attempts: nextAttempts,
        paidCount: nextPaidCount,
        active: complete ? false : item.active,
        nextRunAt: complete ? null : Date.now() + getFrequencyMs(item),
        missedCount: nextMissed,
        catchUpPending: !complete && nextMissed > 0,
      };
    }));
  };

  // Reconciliation runs at mount and on an explicit "Reconcile now" — never
  // on a timer. StrictMode's double-invoked mount effect is absorbed here:
  // the second invocation meets the in-flight flag and the per-key guard, so
  // a lookup (and its exactly-once advance) can never run twice.
  const runRecovery = async () => {
    if (recoveryInFlightRef.current) return;
    recoveryInFlightRef.current = true;
    try {
      const plans = peopleRef.current;
      if (plans.length === 0) return;

      // Pre-recovery schedule snapshot: missed windows are counted against
      // the nextRunAt the plan had when the session opened, so a reconciled
      // success (which moves it) cannot erase the windows behind it.
      const preNextRunAt = new Map();
      const recoveredAdvances = new Map();

      // Phase A — reconcile (never dispatches).
      for (const plan of plans) {
        preNextRunAt.set(plan.id, plan.nextRunAt);
        recoveredAdvances.set(plan.id, 0);
        for (const attempt of Object.values(plan.attempts || {})) {
          const action = mountAttemptAction(attempt);
          if (action === "none") continue;
          const key = installmentId(plan.id, attempt.sequence);
          if (reconcilingKeysRef.current.has(key)) continue;
          reconcilingKeysRef.current.add(key);
          try {
            if (action === "record-failed") {
              // The wallet prompt died with the previous session: nothing was
              // submitted, so there is nothing to reconcile — a failed attempt
              // the card surfaces. Never an advance, never an auto-retry.
              settleRecoveredAttempt(plan.id, key, { ...attempt, status: "validated_failure" });
              addHistoryItem(setHistory, { status: "failed", title: "Recovered attempt failed", detail: `${plan.name || "Plan"} - installment #${attempt.sequence + 1} was awaiting wallet confirmation when the app closed; nothing was submitted.` });
              logEvent("recovery.attempt_recorded_failed", { personId: plan.id, key });
            } else {
              logEvent("recovery.reconcile_started", { personId: plan.id, key, hash: attempt.hash ? `${String(attempt.hash).slice(0, 10)}...` : null });
              const { outcome } = await lookupTransaction(attempt.hash);
              if (outcome === OUTCOMES.SUCCESS) {
                settleRecoveredAttempt(plan.id, key, { ...attempt, status: "validated_success" }, { advance: true });
                recoveredAdvances.set(plan.id, (recoveredAdvances.get(plan.id) || 0) + 1);
                addHistoryItem(setHistory, { status: "success", title: "Recovered payment validated", detail: `${plan.name || "Plan"} - installment #${attempt.sequence + 1} was confirmed by the ledger after the reload.` });
                logEvent("recovery.attempt_validated", { personId: plan.id, key });
              } else if (outcome === OUTCOMES.FAILURE) {
                settleRecoveredAttempt(plan.id, key, { ...attempt, status: "validated_failure" });
                addHistoryItem(setHistory, { status: "failed", title: "Recovered payment failed", detail: `${plan.name || "Plan"} - installment #${attempt.sequence + 1} did not succeed on the ledger; retry is a fresh decision.` });
                logEvent("recovery.attempt_failed", { personId: plan.id, key });
              } else {
                // still_unknown: the installment stays blocked and the card
                // shows the verifying state. Reconciliation re-runs on the
                // next mount or via Reconcile now — never a timer loop.
                settleRecoveredAttempt(plan.id, key, { ...attempt, status: "unresolved" });
                logEvent("recovery.still_unknown", { personId: plan.id, key });
              }
            }
          } finally {
            reconcilingKeysRef.current.delete(key);
          }
        }
      }

      // Phase B — missed windows, assessed AFTER reconciliation. Only active
      // plans with a dispatchable next installment are counted (paused plans
      // and blocked next installments surface their own states); the count is
      // clamped to the remaining budget so clock drift cannot drive a plan
      // past its total.
      const now = Date.now();
      updatePeople((current) => current.map((plan) => {
        if (plan.active !== true) return plan;
        const paidCount = Number(plan.paidCount || 0);
        const remaining = getSchedule(plan).payments - paidCount;
        if (remaining <= 0) return plan;
        if (dispatchBlockReason(plan.attempts?.[installmentId(plan.id, paidCount)])) return plan;
        const missed = Math.max(
          0,
          countMissedWindows({ nextRunAt: preNextRunAt.get(plan.id), frequencyMs: getFrequencyMs(plan), remaining, now })
            - (recoveredAdvances.get(plan.id) || 0),
        );
        if (missed <= 0) return plan;
        return { ...plan, catchUpPending: true, missedCount: missed };
      }));
    } finally {
      recoveryInFlightRef.current = false;
    }
  };

  useEffect(() => {
    // Recovery states (verifying / missed / recovered) live on the plan
    // card's detail pane — surface them immediately by selecting the first
    // restored plan when the user has not chosen one yet. StrictMode's
    // second run keeps whatever selection already exists.
    setSelectedId((current) => current ?? peopleRef.current[0]?.id ?? null);
    void runRecovery();
  }, []);

  // Explicit approval for ONE missed window: the approved installment is sent
  // through the same guarded door as the pay button (source "manual") — never
  // a burst, never an automatic catch-up.
  const approveMissedInstallment = async (person) => {
    const remaining = Number(person?.missedCount || 0);
    if (person?.catchUpPending !== true || remaining <= 0) return;
    logEvent("recovery.window_approved", { personId: person.id, name: person.name, remaining });
    // Open the approval gate for exactly this window's dispatch — the door
    // refuses catch-up plans, so the approved attempt is a fresh user action.
    updatePeople((current) => current.map((item) => item.id === person.id ? { ...item, catchUpPending: false } : item));
    const result = await payInstallment(person, "manual");
    const current = peopleRef.current.find((item) => item.id === person.id);
    if (!current || current.active === false) {
      // Plan finished or paused while the attempt resolved — nothing left to
      // surface for approval.
      updatePeople((c) => c.map((item) => item.id === person.id ? { ...item, catchUpPending: false, missedCount: 0 } : item));
      return;
    }
    if (result?.dispatched && result?.outcome === "validated_success") {
      const nextRemaining = remaining - 1;
      updatePeople((c) => c.map((item) => item.id === person.id ? { ...item, catchUpPending: nextRemaining > 0, missedCount: nextRemaining } : item));
      return;
    }
    if (result?.dispatched && result?.outcome === "unresolved") {
      // The approved window's submission is unclassified: the verifying state
      // owns the card. A reconciled success fills the window and decrements
      // the counter; a reconciled failure leaves a retryable failed attempt.
      return;
    }
    // The approved attempt failed or was refused: the window stays owed, the
    // prompt re-arms (approve again, skip, or retry via the pay button).
    updatePeople((c) => c.map((item) => item.id === person.id ? { ...item, catchUpPending: true, missedCount: remaining } : item));
  };

  // Skipping gives up the missed window's installment: the schedule slides one
  // period forward so the plan's next send lands after the abandoned window.
  const skipMissedWindow = (person) => {
    const remaining = Number(person?.missedCount || 0);
    if (person?.catchUpPending !== true || remaining <= 0) return;
    const nextRemaining = remaining - 1;
    logEvent("recovery.window_skipped", { personId: person.id, name: person.name, remaining });
    updatePeople((current) => current.map((item) => {
      if (item.id !== person.id) return item;
      const nextRunAt = item.nextRunAt != null ? item.nextRunAt + getFrequencyMs(item) : item.nextRunAt;
      return { ...item, catchUpPending: nextRemaining > 0, missedCount: nextRemaining, nextRunAt };
    }));
    addHistoryItem(setHistory, { status: "paused", title: "Missed window skipped", detail: `${person.name} - installment #${Number(person.paidCount || 0) + 1} was skipped; the plan resumes at its next window.` });
  };

  const reconcileNow = (person) => {
    logEvent("recovery.manual_reconcile", { personId: person.id, name: person.name });
    void runRecovery();
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Every due plan gets its own dispatch; the guarded door serializes per
      // installment (plan A's in-flight payment never blocks plan B's due
      // tick, and no entry point can double-send one installment). Catch-up
      // plans are excluded — a missed window never auto-fires; it waits for
      // an explicit approval.
      const duePeople = people.filter((person) =>
        person.active &&
        !person.catchUpPending &&
        person.nextRunAt &&
        Number(person.nextRunAt) <= Date.now() &&
        Number(person.paidCount || 0) < getSchedule(person).payments
      );
      for (const duePerson of duePeople) {
        logEvent("scheduler.due_person_found", {
          personId: duePerson.id,
          name: duePerson.name,
          nextRunAt: duePerson.nextRunAt,
          paidCount: duePerson.paidCount || 0,
          schedule: getSchedule(duePerson),
        });
        // payInstallment classifies its own failures and cannot reject; this
        // catch is a wiring-defect tripwire that logs instead of vanishing.
        payInstallment(duePerson, "scheduled").catch((error) => {
          logEvent("payment.dispatch.failed", { personId: duePerson.id, name: duePerson.name, source: "scheduled", error: safeLogPayload(error) });
        });
      }
    }, 10000);

    return () => window.clearInterval(timer);
  }, [people, signingWallet, walletProvider, walletAddress]);
  const resetWallet = () => {
    logEvent("wallet.reset", { previousWallet: walletAddress ? shortAddress(walletAddress) : "none", peopleCount: people.length });
    clearStartTimer();
    setScreen("intro");
    setAccessInput("");
    setExpectedAddress("");
    setWalletAddress("");
    setRlusdBalance(0);
    setSigningWallet(null);
    setWalletProvider("");
    setSetupError("");
    setDashboardView("employer");
  };

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body {
          margin: 0;
          background:
            linear-gradient(90deg, ${theme.fillSoft} 1px, transparent 1px),
            linear-gradient(180deg, ${theme.fillSoft} 1px, transparent 1px),
            ${theme.bg};
          background-size: 72px 72px;
          color: ${theme.textPrimary};
          font-family: ${theme.fontBody};
        }
        button, input, select { font: inherit; }
        button { cursor: pointer; }
        button:disabled { cursor: not-allowed; opacity: .55; }
        .button:focus-visible, .text-button:focus-visible, .modal-close:focus-visible, a:focus-visible { outline: 2px solid ${theme.accent2}; outline-offset: 2px; }
        .center-screen { min-height: 100vh; display: grid; place-items: center; padding: 28px; position: relative; overflow: hidden; }
        .intro-screen { background: ${theme.bg}; }
        .intro-card, .setup-card { width: min(100%, 540px); position: relative; z-index: 1; }
        .intro-card { padding: 46px 48px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; border-radius: 20px; box-shadow: 0 24px 70px rgba(0,0,0,.45); text-align: center; overflow: hidden; }
        .intro-card > div:first-child { justify-content: center; }
        .brand-lockup { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; }
        .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; flex: 0 0 auto; }
        .brand-mark svg { width: 29px; height: 29px; }
        .intro-card .brand-mark { width: 54px; height: 54px; }
        .intro-card .brand-mark svg { width: 38px; height: 38px; }
        .brand-word { font-family: ${theme.fontHeading}; font-weight: 700; font-size: 30px; line-height: 1; letter-spacing: .02em; text-transform: uppercase; }
        .brand-lockup.compact .brand-word { font-size: 22px; }
        .brand-xrp { margin-top: 3px; font-family: ${theme.fontData}; color: ${theme.accent2}; font-size: 9px; letter-spacing: .35em; }
        .brand-tagline { margin-top: 8px; color: ${theme.textMuted}; font-size: 12px; }
        .eyebrow { margin: 0 0 8px; text-transform: uppercase; letter-spacing: .16em; font-size: 10px; font-weight: 700; color: color-mix(in srgb, ${theme.accent} 75%, ${theme.textPrimary}); font-family: ${theme.fontData}; }
        h1, h2, h3, p { margin-top: 0; }
        h1, h2, h3 { font-family: ${theme.fontHeading}; font-weight: 700; letter-spacing: 0; }
        h1 { font-size: clamp(42px, 6vw, 65px); line-height: .98; margin-bottom: 20px; }
        h1 em { font-style: normal; color: ${theme.accent2}; background: ${theme.gradient}; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
        h2 { font-size: 30px; line-height: 1.05; margin-bottom: 10px; }
        h3 { font-size: 24px; margin: 0; }
        .intro-copy, .section-copy { color: ${theme.textMuted}; line-height: 1.65; font-size: 14px; }
        .intro-copy { max-width: 360px; margin: 0 auto 28px; }
        .intro-note, .security-note, .footer-note { color: ${theme.textMuted}; font-size: 11px; }
        .intro-note { margin-top: 20px; }
        .intro-connect-form { display: grid; gap: 14px; max-width: 390px; margin: 0 auto; text-align: left; }
        .intro-connect-form .button { width: 100%; }
        .xrpl-connector { display: none; }
        .button { border: 0; border-radius: 10px; padding: 13px 18px; font-weight: 700; color: ${theme.textPrimary}; transition: transform .15s ease, box-shadow .15s ease, background .15s ease; }
        .button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(0,0,0,.4); }
        .button-primary { background: ${theme.gradient}; color: ${theme.textPrimary}; }
        .button-secondary { background: ${theme.fillSoft}; border: 1px solid ${theme.hairline}; color: ${theme.textPrimary}; }
        .button-soft { background: ${theme.accentSoft}; color: ${theme.textPrimary}; }
        .button-ghost { padding: 8px 10px; background: transparent; color: ${theme.textMuted}; font-size: 12px; }
        .button-small { padding: 9px 12px; font-size: 12px; background: ${theme.accentSoft}; color: ${theme.textPrimary}; }
        .button span { margin-left: 8px; font-size: 16px; }
        .intro-decoration { position: absolute; border-radius: 50%; filter: blur(1px); opacity: .65; }
        .decoration-one { width: 260px; height: 260px; top: -90px; right: 12%; background: color-mix(in srgb, ${theme.accent} 30%, transparent); }
        .decoration-two { width: 330px; height: 330px; bottom: -170px; left: 4%; background: color-mix(in srgb, ${theme.accent2} 22%, transparent); }
        .setup-screen { background: ${theme.bg}; }
        .setup-card { max-width: 480px; padding: 30px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; border-radius: 24px; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
        .progress-dots { display: flex; gap: 6px; margin: 38px 0 32px; }
        .progress-dots span { width: 32px; height: 4px; border-radius: 4px; background: ${theme.hairline}; }
        .progress-dots .active { background: ${theme.accent}; }
        .setup-card h2 { font-size: 42px; margin-bottom: 14px; }
        .form-stack { display: grid; gap: 16px; margin: 24px 0; }
        .field { display: grid; gap: 7px; min-width: 0; }
        .field-label { font-size: 11px; font-weight: 700; color: ${theme.textPrimary}; }
        .field-help { color: ${theme.textMuted}; font-size: 10px; line-height: 1.4; }
        input, select { width: 100%; min-height: 43px; padding: 10px 12px; border: 1px solid ${theme.hairline}; border-radius: 10px; background: ${theme.fillSoft}; color: ${theme.textPrimary}; outline: none; }
        input:focus, select:focus { border-color: ${theme.accent}; box-shadow: 0 0 0 3px ${theme.accentSoft}; }
        .secret-input-wrap { position: relative; }
        .secret-input-wrap input { padding-right: 68px; }
        .secret-toggle { position: absolute; right: 6px; top: 6px; min-height: 31px; padding: 0 10px; border: 1px solid ${theme.hairline}; border-radius: 8px; background: ${theme.fillSoft}; color: ${theme.textMuted}; font-size: 11px; font-weight: 700; }
        .setup-card .button { width: 100%; }
        .security-note { margin-top: 18px; line-height: 1.45; text-align: center; }
        .security-note span { color: ${theme.danger}; font-size: 15px; margin-right: 4px; }
        .error-message, .success-message { padding: 11px 13px; border-radius: 10px; font-size: 12px; line-height: 1.4; margin-bottom: 14px; }
        .error-message { color: ${theme.danger}; background: ${theme.dangerSoft}; }
        .success-message { color: ${theme.success}; background: color-mix(in srgb, ${theme.success} 12%, transparent); margin-top: 16px; }
        .app-shell { min-height: 100vh; background: transparent; position: relative; overflow: hidden; }
        .topbar { position: relative; z-index: 2; height: 74px; padding: 0 clamp(20px, 5vw, 76px); display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid ${theme.hairline}; background: ${theme.bgOverlay}; backdrop-filter: blur(12px); }
        .topbar-right, .wallet-chip, .welcome-row, .balance-actions, .card-heading, .details-top, .details-actions, .payer-strip { display: flex; align-items: center; }
        .topbar-right { gap: 12px; }
        .wallet-chip, .live-pill { gap: 8px; color: ${theme.textMuted}; font-size: 12px; }
        .wallet-chip { padding: 8px 10px; background: ${theme.fillSoft}; border: 1px solid ${theme.hairline}; border-radius: 10px; font-family: ${theme.fontData}; }
        .online-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: ${theme.success}; box-shadow: 0 0 0 3px color-mix(in srgb, ${theme.success} 18%, transparent); }
        .brand-pattern { position: absolute; pointer-events: none; z-index: 0; }
        .pattern-wave { left: -24vw; top: 96px; width: 150vw; height: 120px; opacity: .3; overflow: visible; }
        .pattern-wave svg { width: 116%; height: 100%; margin-left: -8%; animation: brandWaveDrift 18s ease-in-out infinite alternate; }
        .pattern-wave path { fill: none; stroke: ${theme.accent}; stroke-width: 1.2; stroke-linecap: round; stroke-dasharray: 28 18 84 22; animation: brandWaveFlow var(--wave-speed, 11s) linear infinite; }
        .pattern-wave path:nth-child(1), .pattern-wave path:nth-child(2) { stroke: ${theme.accent2}; }
        .pattern-wave path:nth-child(1) { --wave-speed: 9s; }
        .pattern-wave path:nth-child(2) { --wave-speed: 10.5s; animation-direction: reverse; }
        .pattern-wave path:nth-child(3) { --wave-speed: 12s; }
        .pattern-wave path:nth-child(4) { --wave-speed: 13.5s; animation-direction: reverse; }
        .pattern-wave path:nth-child(5) { --wave-speed: 15s; }
        .pattern-wave path:nth-child(6) { --wave-speed: 16.5s; animation-direction: reverse; }
        .pattern-dots { right: 7%; top: 132px; width: 134px; height: 96px; opacity: .34; background-image: radial-gradient(circle, ${theme.accent2} 1.8px, transparent 2px); background-size: 18px 18px; animation: dotPulse 4.6s ease-in-out infinite alternate; }
        .pattern-rings { right: 6%; top: 190px; width: 170px; height: 170px; border-radius: 50%; border: 1px solid color-mix(in srgb, ${theme.accent} 45%, transparent); box-shadow: 0 0 0 18px color-mix(in srgb, ${theme.accent} 8%, transparent), 0 0 0 37px color-mix(in srgb, ${theme.accent} 26%, transparent), 0 0 0 57px color-mix(in srgb, ${theme.accent} 16%, transparent); opacity: .75; }
        .pattern-lines { right: 8%; bottom: 40px; width: 190px; height: 130px; opacity: .26; background: repeating-linear-gradient(135deg, transparent 0 13px, ${theme.hairline} 13px 14px, transparent 14px 27px); }
        .pattern-lines:before, .pattern-lines:after { content: ""; position: absolute; width: 2px; height: 76px; background: ${theme.accent2}; transform: rotate(45deg); }
        .pattern-lines:before { right: 44px; top: 14px; }
        .pattern-lines:after { right: 88px; bottom: 8px; opacity: .55; }
        .intro-card .pattern-rings { top: 24px; right: -62px; width: 130px; height: 130px; opacity: .52; }
        .intro-screen > .pattern-wave { top: 18%; opacity: .2; }
        .intro-screen > .pattern-dots { left: 8%; right: auto; top: auto; bottom: 12%; }
        .employee-app > .pattern-dots { top: 260px; }
        .proof-app > .pattern-wave { opacity: .16; }
        @keyframes brandWaveDrift { 0% { transform: translateX(-4%); } 100% { transform: translateX(4%); } }
        @keyframes brandWaveFlow { to { stroke-dashoffset: -260; } }
        @keyframes dotPulse { 0% { opacity: .18; transform: translateY(0); } 100% { opacity: .42; transform: translateY(-8px); } }
        .dashboard-content { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 54px clamp(20px, 5vw, 76px) 40px; }
        .welcome-row { justify-content: space-between; gap: 20px; margin-bottom: 30px; }
        .welcome-row h1 { font-size: clamp(38px, 5vw, 58px); margin-bottom: 10px; }
        .muted-line { margin: 0; color: ${theme.textMuted}; font-size: 13px; }
        .live-pill { padding: 8px 12px; border-radius: 99px; background: color-mix(in srgb, ${theme.success} 14%, transparent); color: ${theme.success}; font-weight: 700; }
        .stream-widget { position: relative; display: grid; gap: 22px; margin-bottom: 14px; padding: 28px 30px 24px; border: 1px solid ${theme.hairline}; border-radius: 12px; background: radial-gradient(circle at 82% 20%, color-mix(in srgb, ${theme.accent} 14%, transparent), transparent 32%), ${theme.bgRaised}; color: ${theme.textPrimary}; box-shadow: 0 24px 54px rgba(0,0,0,.4); overflow: hidden; }
        .stream-widget-rings { position: absolute; right: -82px; top: 28px; width: 170px; height: 170px; border-radius: 50%; border: 1px solid color-mix(in srgb, ${theme.accent2} 35%, transparent); box-shadow: 0 0 0 18px color-mix(in srgb, ${theme.accent2} 8%, transparent), 0 0 0 36px color-mix(in srgb, ${theme.accent2} 5%, transparent); }
        .stream-top, .stream-stats, .stream-footer { position: relative; z-index: 1; }
        .stream-top { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
        .stream-label, .stream-live { font-family: ${theme.fontData}; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
        .stream-label { margin: 0 0 14px; color: ${theme.textMuted}; }
        .stream-live { display: inline-flex; align-items: center; gap: 7px; color: ${theme.success}; animation: livePulse 2.4s ease-in-out infinite alternate; }
        .stream-amount { font-family: ${theme.fontData}; font-size: clamp(42px, 7vw, 72px); line-height: 1; letter-spacing: -.03em; }
        .stream-amount span { color: ${theme.accent2}; }
        .stream-subcopy { margin: 8px 0 0; color: ${theme.textMuted}; font-size: 12px; line-height: 1.5; max-width: 560px; }
        .stream-wave { position: relative; z-index: 1; width: 100%; height: 72px; overflow: visible; }
        .stream-wave path { fill: none; }
        .stream-wave-base { stroke: ${theme.hairline}; stroke-width: 1; }
        .stream-wave-line { stroke: ${theme.accent2}; stroke-width: 2; stroke-linecap: round; stroke-dasharray: 130 28 18 28; animation: streamLineFlow 3.2s linear infinite; filter: drop-shadow(0 0 6px color-mix(in srgb, ${theme.accent2} 60%, transparent)); }
        .stream-wave circle { fill: ${theme.accent2}; animation: streamDot 2.4s ease-in-out infinite alternate; }
        .stream-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding-top: 18px; border-top: 1px solid ${theme.hairline}; }
        .stream-stats strong { display: block; font-family: ${theme.fontData}; font-size: 16px; color: ${theme.textPrimary}; word-break: break-word; }
        .stream-stats span { display: block; margin-top: 5px; color: ${theme.textFaint}; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
        .stream-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
        .stream-footer code { color: ${theme.textMuted}; word-break: break-all; }
        .stream-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .stream-widget .button-secondary { background: ${theme.fillSoft}; border-color: ${theme.hairline}; }
        .stream-widget .button-soft { background: ${theme.accentSoft}; }
        @keyframes streamLineFlow { to { stroke-dashoffset: -204; } }
        @keyframes streamDot { 0% { transform: translateY(0); } 100% { transform: translateY(-16px); } }
        @keyframes livePulse { 0% { opacity: .72; } 100% { opacity: 1; } }
        .payer-strip { justify-content: space-between; gap: 18px; padding: 17px 20px; margin: 14px 0 34px; border: 1px solid ${theme.hairline}; border-radius: 16px; background: ${theme.bgRaised}; }
        .payer-strip strong { display: block; font: 600 17px ${theme.fontHeading}; }
        .payer-strip span { display: block; margin-top: 4px; color: ${theme.textMuted}; font-size: 11px; }
        .content-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(420px, 1.2fr); gap: 16px; align-items: stretch; }
        .people-card, .details-card, .editor-card { padding: 24px; border: 1px solid ${theme.hairline}; border-radius: 20px; background: ${theme.bgRaised}; }
        .card-heading { justify-content: space-between; gap: 12px; margin-bottom: 22px; }
        .card-heading h2 { font-size: 25px; margin: 0; }
        .card-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .people-list { display: grid; gap: 7px; }
        .person-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto 8px; align-items: center; gap: 10px; width: 100%; padding: 11px; border: 1px solid transparent; border-radius: 14px; background: transparent; text-align: left; color: ${theme.textPrimary}; }
        .person-row:hover, .person-row.selected { background: ${theme.accentSoft}; border-color: color-mix(in srgb, ${theme.accent} 45%, transparent); }
        .avatar, .large-avatar { display: grid; place-items: center; border-radius: 13px; background: ${theme.accentSoft}; color: ${theme.textPrimary}; font-weight: 700; }
        .avatar { width: 38px; height: 38px; }
        .person-info, .person-amount { min-width: 0; display: grid; gap: 3px; }
        .person-info b, .person-amount b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .person-info small, .person-amount small { color: ${theme.textMuted}; font-size: 10px; }
        .person-amount { text-align: right; }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; background: ${theme.textFaint}; }
        .status-dot.on { background: ${theme.success}; }
        .empty-people, .details-empty { min-height: 290px; display: grid; place-items: center; align-content: center; text-align: center; color: ${theme.textMuted}; }
        .empty-people p, .details-empty p { max-width: 240px; line-height: 1.55; font-size: 13px; }
        .empty-scribble, .empty-sun { color: ${theme.accent}; font: 34px ${theme.fontHeading}; margin-bottom: 12px; }
        .details-top { gap: 14px; position: relative; }
        .large-avatar { width: 56px; height: 56px; border-radius: 18px; font-size: 22px; }
        .details-top h2 { font-size: 30px; margin: 0 0 4px; }
        .edit-button { margin-left: auto; }
        .text-button { border: 0; padding: 4px; background: transparent; color: ${theme.accent}; font-size: 12px; font-weight: 700; }
        .address-line { display: flex; justify-content: space-between; gap: 12px; padding: 15px 0; margin: 20px 0; border-top: 1px solid ${theme.hairline}; border-bottom: 1px solid ${theme.hairline}; color: ${theme.textMuted}; font-size: 11px; }
        code { font-family: ${theme.fontData}; color: ${theme.textPrimary}; }
        .detail-highlight { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; padding: 20px; border-radius: 16px; background: ${theme.fillSoft}; }
        .detail-highlight strong { display: block; font: 600 28px ${theme.fontHeading}; margin: 5px 0; }
        .detail-highlight small { display: block; color: ${theme.textMuted}; font-size: 10px; }
        .highlight-arrow { color: ${theme.accent2}; font-size: 28px; }
        .details-actions { gap: 10px; flex-wrap: wrap; margin-top: 20px; }
        .plan-meter { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
        .plan-meter > div { padding: 12px; border: 1px solid ${theme.hairline}; border-radius: 12px; background: ${theme.fillSoft}; }
        .plan-meter span, .plan-meter strong { display: block; }
        .plan-meter span { color: ${theme.textMuted}; font-size: 10px; }
        .plan-meter strong { margin-top: 4px; font-size: 12px; }
        .inline-note, .safe-payment-note { color: ${theme.textMuted}; font-size: 11px; line-height: 1.5; }
        .recovery-note { margin-top: 14px; padding: 12px 14px; border: 1px solid ${theme.hairline}; border-radius: 12px; background: ${theme.fillSoft}; font-size: 12px; line-height: 1.5; color: ${theme.textMuted}; }
        .recovery-note b { display: block; color: ${theme.textPrimary}; font-size: 13px; }
        .recovery-note span { display: block; margin-top: 4px; }
        .recovery-note .details-actions { margin-top: 12px; margin-bottom: 0; }
        .recovery-verifying { border-color: color-mix(in srgb, ${theme.accent2} 45%, transparent); }
        .recovery-verifying b { color: ${theme.accent2}; }
        .recovery-missed { border-color: color-mix(in srgb, ${theme.accent} 45%, transparent); }
        .safe-payment-note { padding: 12px; margin-top: 20px; background: ${theme.fillSoft}; border-left: 2px solid ${theme.accent2}; border-radius: 10px; }
        .safe-payment-note span { color: ${theme.accent2}; margin-right: 6px; }
        .footer-note { max-width: 760px; margin: 24px auto 0; text-align: center; line-height: 1.5; }
        .history-panel { margin-top: 16px; padding: 24px; border: 1px solid ${theme.hairline}; border-radius: 20px; background: ${theme.bgRaised}; }
        .history-list { display: grid; gap: 8px; }
        .history-row { display: flex; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid ${theme.hairline}; border-radius: 12px; background: ${theme.fillSoft}; }
        .history-row b, .history-row span, .history-row time { display: block; }
        .history-row b { font-size: 13px; }
        .history-row span, .history-row time { color: ${theme.textMuted}; font-size: 11px; line-height: 1.4; }
        .history-row.success { border-color: color-mix(in srgb, ${theme.success} 45%, transparent); }
        .history-row.failed { border-color: color-mix(in srgb, ${theme.danger} 45%, transparent); background: ${theme.dangerSoft}; }
        .editor-card { grid-column: 1 / -1; }
        .editor-heading { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
        .editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .pay-plan-box { margin: 22px 0; padding: 18px; border-radius: 16px; background: ${theme.fillSoft}; }
        .pay-plan-title { font: 600 18px ${theme.fontHeading}; margin-bottom: 16px; }
        .mode-toggle { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 16px; padding: 9px 11px; border: 1px solid ${theme.hairline}; border-radius: 10px; background: ${theme.fillSoft}; color: ${theme.textPrimary}; font-size: 12px; font-weight: 700; }
        .mode-toggle input { width: 16px; min-height: 16px; padding: 0; accent-color: ${theme.accent}; }
        .plan-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .input-with-symbol { position: relative; }
        .input-with-symbol span { position: absolute; left: 12px; top: 12px; color: ${theme.textMuted}; }
        .input-with-symbol input { padding-left: 26px; }
        .schedule-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-top: 18px; margin-top: 18px; border-top: 1px solid ${theme.hairline}; }
        .schedule-summary > div { display: grid; gap: 5px; }
        .summary-label { color: ${theme.textMuted}; font-size: 10px; }
        .schedule-summary strong { font: 600 18px ${theme.fontHeading}; }
        .modal-backdrop { position: fixed; z-index: 10; inset: 0; display: grid; place-items: center; padding: 20px; background: ${theme.bgOverlay}; }
        .modal-card { width: min(100%, 430px); position: relative; padding: 34px; border-radius: 22px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; box-shadow: 0 20px 70px rgba(0,0,0,.5); }
        .modal-close { position: absolute; top: 15px; right: 17px; border: 0; background: transparent; color: ${theme.textMuted}; font-size: 26px; }
        .modal-icon { margin-bottom: 20px; }
        .modal-card h2 { font-size: 38px; }
        .funding-steps { display: grid; gap: 13px; margin: 22px 0 26px; }
        .funding-steps > div { display: grid; grid-template-columns: 25px 1fr; gap: 9px; align-items: start; color: ${theme.textMuted}; font-size: 12px; line-height: 1.45; }
        .funding-steps b { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: ${theme.accent}; color: ${theme.textPrimary}; font-size: 11px; }
        .employee-app { background: linear-gradient(180deg, ${theme.bg} 0%, ${theme.bgRaised} 100%); }
        .employee-content { max-width: 1000px; display: flex; flex-direction: column; gap: 18px; }
        .employee-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .employee-hero .eyebrow { display: flex; align-items: center; gap: 8px; }
        .employee-hero h1 { font-size: clamp(38px, 5vw, 58px); margin-bottom: 10px; }
        .employee-balance-card { display: grid; gap: 22px; padding: 30px 34px; border-radius: 24px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; color: ${theme.textPrimary}; box-shadow: 0 18px 40px rgba(0,0,0,.4); }
        .employee-balance-card .eyebrow { color: color-mix(in srgb, ${theme.accent} 75%, ${theme.textPrimary}); }
        .employee-balance-card p { margin: 0; color: ${theme.textMuted}; font-size: 13px; }
        .employee-balance-top, .employee-balance-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .employee-balance-footer { align-items: flex-end; padding-top: 18px; border-top: 1px solid ${theme.hairline}; }
        .employee-balance-footer code { color: ${theme.textMuted}; }
        .employee-balance-footer > div { display: grid; justify-items: end; gap: 8px; }
        .employee-balance-number { font: 600 clamp(54px, 8vw, 86px)/1 ${theme.fontHeading}; letter-spacing: -.04em; margin: 8px 0 12px; }
        .employee-balance-number span { color: ${theme.accent2}; }
        .employee-live-tag { display: inline-flex; align-items: center; gap: 7px; width: fit-content; padding: 7px 10px; border-radius: 999px; background: color-mix(in srgb, ${theme.success} 14%, transparent); color: ${theme.success}; font-size: 11px; font-weight: 700; text-transform: uppercase; }
        .employee-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .employee-card { padding: 24px; border: 1px solid ${theme.hairline}; border-radius: 20px; background: ${theme.bgRaised}; box-shadow: 0 10px 24px rgba(0,0,0,.35); }
        .employee-card strong { display: block; font: 600 30px ${theme.fontHeading}; margin-bottom: 6px; color: ${theme.textPrimary}; }
        .employee-card span, .employee-card small { color: ${theme.textMuted}; font-size: 12px; }
        .employee-progress { height: 9px; overflow: hidden; margin: 16px 0 9px; border-radius: 999px; background: ${theme.fillSoft}; }
        .employee-progress div { height: 100%; border-radius: inherit; background: ${theme.gradient}; transition: width .2s ease; }
        .employee-meta-row { display: flex; gap: 30px; margin-top: 18px; flex-wrap: wrap; }
        .employee-meta-row small, .employee-meta-row b { display: block; }
        .employee-meta-row b { margin-top: 3px; font-size: 13px; }
        .employee-history-card .card-heading { margin-bottom: 16px; }
        .employee-table-wrap { overflow: auto; }
        .employee-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .employee-table th { padding: 10px 8px; border-bottom: 1px solid ${theme.hairline}; color: ${theme.textMuted}; text-align: left; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
        .employee-table td { padding: 12px 8px; border-bottom: 1px solid ${theme.hairline}; color: ${theme.textPrimary}; }
        .employee-table td:nth-child(3) { color: ${theme.textMuted}; font-family: ${theme.fontData}; }
        .employee-table td span { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: color-mix(in srgb, ${theme.success} 14%, transparent); color: ${theme.success}; font-size: 11px; font-weight: 700; }
        .proof-app { background: ${theme.bg}; }
        .proof-topbar { background: ${theme.bgOverlay}; border-bottom: 0; }
        .proof-content { max-width: 900px; margin: 0 auto; padding: 18px clamp(20px, 4vw, 44px) 44px; display: flex; flex-direction: column; gap: 18px; }
        .proof-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
        .proof-heading .eyebrow { display: flex; align-items: center; gap: 8px; color: color-mix(in srgb, ${theme.accent} 75%, ${theme.textPrimary}); }
        .proof-heading h1 { color: ${theme.textPrimary}; font-size: clamp(36px, 5vw, 52px); margin-bottom: 8px; }
        .proof-heading p { max-width: 540px; margin: 0; color: ${theme.textMuted}; line-height: 1.5; }
        .proof-pill { display: inline-flex; align-items: center; padding: 7px 12px; border-radius: 999px; background: ${theme.accentSoft}; color: ${theme.textPrimary}; font-size: 11px; white-space: nowrap; }
        .proof-reference { display: grid; gap: 18px; padding: 22px 18px; border-radius: 28px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; color: ${theme.textPrimary}; }
        .proof-reference-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid ${theme.hairline}; }
        .proof-reference-top p, .proof-reference small { margin: 0; color: ${theme.textFaint}; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
        .proof-reference-top strong { display: block; margin-top: 4px; font: 600 22px ${theme.fontHeading}; letter-spacing: .02em; }
        .proof-reference-top span { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 999px; background: color-mix(in srgb, ${theme.success} 14%, transparent); color: ${theme.success}; font-size: 11px; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
        .proof-reference-top i { width: 6px; height: 6px; border-radius: 999px; background: ${theme.success}; }
        .proof-reference-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 28px; }
        .proof-reference b { display: block; margin-top: 4px; font-size: 13px; word-break: break-all; }
        .payer-source-badge { display: inline-flex; align-items: center; margin-top: 7px; padding: 3px 9px; border-radius: 999px; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        .payer-source-badge.payer-source-plan { background: rgba(33,212,194,.16); color: ${theme.success}; }
        .payer-source-badge.payer-source-demo { background: ${theme.dangerSoft}; color: ${theme.danger}; }
        .proof-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
        .proof-card { padding: 20px 14px; border-radius: 28px; background: ${theme.bgRaised}; border: 1px solid ${theme.hairline}; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
        .proof-card .eyebrow { color: color-mix(in srgb, ${theme.accent} 75%, ${theme.textPrimary}); }
        .proof-card strong { display: block; color: ${theme.textPrimary}; font: 600 30px ${theme.fontHeading}; margin: 8px 0; }
        .proof-card span, .proof-card p { color: ${theme.textMuted}; font-size: 13px; line-height: 1.5; }
        .proof-status { padding: 13px 16px; border-radius: 16px; background: ${theme.accentSoft}; color: ${theme.textPrimary}; font-size: 13px; line-height: 1.5; }
        .proof-status.error { background: ${theme.dangerSoft}; color: ${theme.danger}; }
        .proof-projection { padding: 24px 14px; }
        .proof-projection h2, .proof-ledger h2 { font-size: 20px; color: ${theme.textPrimary}; letter-spacing: 0; margin-bottom: 18px; }
        .proof-projection-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-bottom: 18px; }
        .proof-projection-grid small { display: block; color: ${theme.textMuted}; margin-bottom: 5px; }
        .proof-projection-grid strong { font-size: 24px; margin: 0; }
        .proof-ledger { padding: 14px; }
        .proof-ledger-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
        .proof-ledger-head h2 { margin: 0; }
        .proof-ledger-head > div:last-child { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .proof-disclaimer { max-width: 680px; margin: 0; color: ${theme.textMuted}; font-size: 12px; line-height: 1.5; }
        @media (max-width: 760px) {
          .topbar { height: auto; padding: 18px 20px; gap: 14px; flex-wrap: wrap; }
          .topbar-right { width: 100%; justify-content: space-between; }
          .dashboard-content { padding-top: 32px; }
          .welcome-row, .payer-strip { align-items: flex-start; flex-direction: column; }
          .content-grid { grid-template-columns: 1fr; }
          .employee-balance-card { padding: 25px; }
          .employee-stat-grid { grid-template-columns: 1fr; }
          .proof-reference-grid, .proof-stat-grid, .proof-projection-grid { grid-template-columns: 1fr; }
          .plan-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 480px) {
          .intro-card, .setup-card, .people-card, .details-card, .editor-card { padding: 22px; }
          .intro-card { border-radius: 20px; }
          .intro-card .brand-mark { width: 42px; height: 42px; font-size: 25px; }
          .detail-highlight { gap: 8px; padding: 14px; }
          .detail-highlight strong { font-size: 22px; }
          .editor-grid, .plan-grid, .schedule-summary { grid-template-columns: 1fr; }
          .schedule-summary { gap: 14px; }
          .person-row { grid-template-columns: 36px minmax(0, 1fr) 8px; }
          .person-amount { display: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .pattern-wave svg, .pattern-wave path, .pattern-dots, .stream-live, .stream-wave-line, .stream-wave circle { animation: none; }
        }
      `}</style>
      {screen === "intro" && <Intro method={method} setMethod={setMethod} accessInput={accessInput} setAccessInput={setAccessInput} expectedAddress={expectedAddress} setExpectedAddress={setExpectedAddress} onSubmit={finishSetup} error={setupError} isLocal={localDesktop} connectorRef={xrplConnectorRef} xrplManager={xrplConnectManager} />}
      {screen === "dashboard" && (
        <>
          {editorOpen ? (
            <div className="app-shell"><header className="topbar"><CadenceLockup compact /><Button kind="ghost" onClick={() => setEditorOpen(false)}>Back to dashboard</Button></header><main className="dashboard-content"><PersonEditor person={editingPerson} onSave={savePerson} onCancel={() => { setEditorOpen(false); setEditingPerson(null); }} /></main></div>
          ) : dashboardView === "employee" ? (
            <EmployeeDashboard walletAddress={walletAddress} rlusdBalance={rlusdBalance} balanceLoading={balanceLoading} onRefreshBalance={() => refreshBalance()} people={people} onBack={() => setDashboardView("employer")} onExportLogs={exportLogs} onReset={resetWallet} />
          ) : <Dashboard walletAddress={walletAddress} walletProvider={walletProvider} rlusdBalance={rlusdBalance} balanceLoading={balanceLoading} onRefreshBalance={() => refreshBalance()} onOpenFunding={() => setShowFunding(true)} onReset={resetWallet} people={people} onAdd={() => { setEditingPerson(null); setEditorOpen(true); }} selectedId={selectedId} onSelect={setSelectedId} onSave={savePerson} onEdit={(person) => { setEditingPerson(person); setEditorOpen(true); }} onToggle={togglePlan} onPay={payInstallment} onApproveMissed={approveMissedInstallment} onSkipMissed={skipMissedWindow} onReconcileNow={reconcileNow} paymentMessage={paymentMessage} history={history} onExportLogs={exportLogs} onOpenEmployee={() => setDashboardView("employee")} />}
          {showFunding && <FundingModal onClose={() => setShowFunding(false)} />}
        </>
      )}
    </>
  );
}
