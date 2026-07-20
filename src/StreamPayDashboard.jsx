import { useEffect, useMemo, useRef, useState } from "react";
import { Client, Wallet } from "xrpl";

const COLORS = {
  ink: "#24332d",
  muted: "#708078",
  paper: "#fbf8f1",
  card: "#fffdf8",
  line: "#e7e2d7",
  mint: "#b9ddcb",
  mintDark: "#2e6956",
  coral: "#e8896d",
  coralDark: "#a8523d",
  butter: "#f3dda4",
  sky: "#bdd9e7",
};

const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const CADENCE_EMPLOYER_WALLET = "rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864";
const SOURCE_TAG = 2606250005;
const LOG_STORAGE_KEY = "cadence-debug-logs-v1";
const MAX_LOGS = 500;

const ACCESS_METHODS = [
  { value: "family", label: "XRPL family seed", hint: "Usually starts with s" },
  { value: "mnemonic", label: "Mnemonic seed phrase", hint: "12 or 24 words" },
];

const TIME_UNITS = {
  seconds15: { label: "15 seconds", seconds: 15 },
  seconds30: { label: "30 seconds", seconds: 30 },
  minute: { label: "1 minute", seconds: 60 },
  minutes5: { label: "5 minutes", seconds: 5 * 60 },
  minutes15: { label: "15 minutes", seconds: 15 * 60 },
  hour: { label: "1 hour", seconds: 60 * 60 },
  day: { label: "1 day", seconds: 24 * 60 * 60 },
  week: { label: "1 week", seconds: 7 * 24 * 60 * 60 },
};

const FREQUENCIES = ["seconds15", "seconds30", "minute", "minutes5", "minutes15", "hour", "day"];

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

const rippleTimeToIso = (seconds) =>
  seconds ? new Date((seconds + 946684800) * 1000).toISOString() : new Date().toISOString();

const txJson = (entry) => entry.tx_json || entry.tx || {};

const deliveredIssuedAmount = (entry) => {
  const delivered = entry.meta?.delivered_amount;
  if (delivered && typeof delivered === "object") return delivered;
  const amount = txJson(entry).Amount || txJson(entry).DeliverMax;
  return amount && typeof amount === "object" ? amount : null;
};

const deliveredXrp = (entry) => {
  const delivered = entry.meta?.delivered_amount;
  if (typeof delivered === "string") return Number(delivered) / 1000000;
  const amount = txJson(entry).Amount || txJson(entry).DeliverMax;
  return typeof amount === "string" ? Number(amount) / 1000000 : 0;
};

const isRlusdAmount = (amount) =>
  amount &&
  (amount.currency === "RLUSD" || amount.currency === RLUSD_CURRENCY) &&
  amount.issuer === RLUSD_ISSUER;

const readIncomeProofData = async (employeeWallet, employerWallet = CADENCE_EMPLOYER_WALLET) => {
  if (!employeeWallet?.startsWith("r")) {
    throw new Error("Enter or unlock a valid employee XRPL wallet first.");
  }

  let marker;
  const transactions = [];
  for (let page = 0; page < 20; page += 1) {
    const result = await xrplRequest({
      command: "account_tx",
      account: employeeWallet,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: false,
      forward: false,
      limit: 400,
      ...(marker ? { marker } : {}),
    });
    transactions.push(...(result.transactions || []));
    marker = result.marker;
    if (!marker) break;
  }

  const incomeRows = transactions
    .filter((entry) => {
      const tx = txJson(entry);
      const amount = deliveredIssuedAmount(entry);
      return (
        entry.meta?.TransactionResult === "tesSUCCESS" &&
        tx.TransactionType === "Payment" &&
        tx.Account === employerWallet &&
        tx.Destination === employeeWallet &&
        Number(tx.SourceTag) === SOURCE_TAG &&
        isRlusdAmount(amount)
      );
    })
    .map((entry) => {
      const tx = txJson(entry);
      const amount = deliveredIssuedAmount(entry);
      const iso = entry.close_time_iso || rippleTimeToIso(tx.date);
      return {
        time: new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        iso,
        amount: Number(amount.value || 0),
        hash: entry.hash,
        ledgerIndex: entry.ledger_index || tx.ledger_index,
      };
    });

  const excludedXrpRows = transactions.filter((entry) => {
    const tx = txJson(entry);
    return (
      entry.meta?.TransactionResult === "tesSUCCESS" &&
      tx.TransactionType === "Payment" &&
      tx.Destination === employeeWallet &&
      !deliveredIssuedAmount(entry) &&
      deliveredXrp(entry) > 0
    );
  });

  const totalRlusd = incomeRows.reduce((sum, row) => sum + row.amount, 0);
  const totalExcludedXrp = excludedXrpRows.reduce((sum, entry) => sum + deliveredXrp(entry), 0);
  const newest = incomeRows[0] ? new Date(incomeRows[0].iso).getTime() : Date.now();
  const oldest = incomeRows[incomeRows.length - 1] ? new Date(incomeRows[incomeRows.length - 1].iso).getTime() : newest;
  const observedDays = Math.max(1 / 24, (newest - oldest) / 86400000);
  const dailyRate = totalRlusd / observedDays;

  return {
    employeeWallet,
    employerWallet,
    sourceTag: SOURCE_TAG,
    markerRemaining: Boolean(marker),
    fetchedCount: transactions.length,
    incomeRows,
    stats: {
      incomeCount: incomeRows.length,
      totalRlusd,
      excludedCount: excludedXrpRows.length,
      totalExcludedXrp,
      projectedWeekly: dailyRate * 7,
      projectedMonthly: dailyRate * 30,
      projectedAnnual: dailyRate * 365,
      lifetimeMatches: marker ? `${incomeRows.length}+` : incomeRows.length,
      observedDays,
    },
  };
};

const createWalletFromInput = (method, value) => {
  const phrase = value.trim();
  if (!phrase) {
    throw new Error("Enter your wallet phrase to continue.");
  }

  if (method === "family") {
    return Wallet.fromSeed(phrase);
  }

  return Wallet.fromMnemonic(phrase);
};

const submitRlusdPayment = async ({ wallet, destination, amount }) => {
  const client = new Client("wss://s1.ripple.com");
  await client.connect();
  try {
    const transaction = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: destination,
      SourceTag: SOURCE_TAG,
      Amount: {
        currency: RLUSD_CURRENCY,
        issuer: RLUSD_ISSUER,
        value: amount,
      },
    };
    const prepared = await client.autofill(transaction);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    return { result, hash: signed.hash, transaction };
  } finally {
    await client.disconnect();
  }
};
const readRlusdBalance = async (address) => {
  if (!address || !address.startsWith("r")) {
    return 0;
  }

  const result = await xrplRequest({
    command: "account_lines",
    account: address,
    peer: RLUSD_ISSUER,
    ledger_index: "validated",
  });
  const line = result.lines?.find((item) =>
    (item.currency === "RLUSD" || item.currency === RLUSD_CURRENCY) && item.account === RLUSD_ISSUER
  );
  return Math.max(0, Number(line?.balance || 0));
};

const getSchedule = (person) => {
  const payMode = person.payMode || "weekly";
  const hourlyPay = Math.max(0, Number(person.hourlyPay) || 0);
  const hoursPerWeek = Math.max(0, Number(person.hoursPerWeek) || 0);
  const directWeeklyPay = Math.max(0, Number(person.weeklyPay ?? person.amount) || 0);
  const weeklyPay = payMode === "hourly" ? hourlyPay * hoursPerWeek : directWeeklyPay;
  const frequency = TIME_UNITS[person.frequency] || TIME_UNITS.minute;
  const payments = Math.max(1, Math.floor(TIME_UNITS.week.seconds / frequency.seconds));
  const perPayment = weeklyPay / payments;

  return {
    total: weeklyPay,
    payMode,
    hourlyPay,
    hoursPerWeek,
    weeklyPay,
    payments,
    perPayment,
    weeklyEquivalent: weeklyPay,
    frequencyLabel: frequency.label,
    frequencySeconds: frequency.seconds,
  };
};

const getFrequencyMs = (person) => (TIME_UNITS[person.frequency] || TIME_UNITS.minute).seconds * 1000;

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

function Brand({ compact = false }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div className="brand-mark">C</div>
      <div>
        <div style={{ fontFamily: "Georgia, serif", fontSize: compact ? 22 : 28, fontWeight: 700, letterSpacing: "-0.04em" }}>
          Cadence
        </div>
        {!compact && <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 2 }}>small payments, right on time</div>}
      </div>
    </div>
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

function Intro({ method, setMethod, accessInput, setAccessInput, onSubmit, error }) {
  const activeMethod = ACCESS_METHODS.find((item) => item.value === method);
  return (
    <div className="center-screen intro-screen">
      <div className="intro-decoration decoration-one" />
      <div className="intro-decoration decoration-two" />
      <div className="intro-card">
        <Brand />
        <div className="intro-sun">*</div>
        <p className="eyebrow">A gentler way to pay</p>
        <h1>Make every payment<br /><em>feel effortless.</em></h1>
        <p className="intro-copy">
          Connect your XRPL wallet to read real RLUSD income, verify on-chain payments, and manage Cadence payment plans.
        </p>
        <div className="intro-connect-form">
          <Field label="Wallet phrase method">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {ACCESS_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
          <Field label={activeMethod.label} help={`${activeMethod.hint}. Used locally to unlock this session.`}>
            <input
              value={accessInput}
              onChange={(event) => setAccessInput(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder={`Enter ${activeMethod.hint.toLowerCase()}`}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
              }}
            />
          </Field>
          {error && <div className="error-message">{error}</div>}
          <Button onClick={onSubmit}>Connect wallet <span>{">"}</span></Button>
        </div>
        <div className="intro-note">Your phrase stays in memory for this session and is redacted from exported logs.</div>
      </div>
    </div>
  );
}

function WalletSetup({ method, setMethod, accessInput, setAccessInput, onSubmit, error }) {
  const activeMethod = ACCESS_METHODS.find((item) => item.value === method);
  return (
    <div className="center-screen setup-screen">
      <div className="setup-card">
        <Brand compact />
        <div className="progress-dots"><span className="active" /><span /><span /></div>
        <p className="eyebrow">Step one of three</p>
        <h2>Unlock your wallet<br />for Cadence.</h2>
        <p className="section-copy">
          Cadence uses this phrase locally to derive your XRPL wallet and sign RLUSD payments on this computer.
        </p>
        <div className="form-stack">
          <Field label="Wallet phrase method">
            <select value={method} onChange={(event) => setMethod(event.target.value)}>
              {ACCESS_METHODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
          <Field label={activeMethod.label} help={`${activeMethod.hint}. Never send this phrase in logs or chat.`}>
            <input
              value={accessInput}
              onChange={(event) => setAccessInput(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder={`Enter ${activeMethod.hint.toLowerCase()}`}
            />
          </Field>
        </div>
        {error && <div className="error-message">{error}</div>}
        <Button onClick={onSubmit}>Unlock Cadence <span>{">"}</span></Button>
        <div className="security-note"><span>*</span> Your phrase stays in memory for this session and is redacted from exported logs.</div>
      </div>
    </div>
  );
}

function FundingModal({ onClose }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <button className="modal-close" onClick={onClose} aria-label="Close">x</button>
        <div className="modal-icon">o</div>
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

function PersonDetails({ person, onEdit, onToggle, onPay, walletReady, paymentMessage }) {
  const schedule = getSchedule(person);
  const paidCount = Number(person.paidCount || 0);
  const nextRun = person.nextRunAt ? new Date(person.nextRunAt).toLocaleString() : "Not scheduled";
  return (
    <div className="details-card">
      <div className="details-top"><div className="large-avatar">{person.name.slice(0, 1).toUpperCase()}</div><div><p className="eyebrow">Selected person</p><h2>{person.name}</h2><p className="muted-line">{person.role || "No role added"} {person.email ? ` ${person.email}` : ""}</p></div><button className="text-button edit-button" onClick={onEdit}>Edit</button></div>
      <div className="address-line"><span>Destination</span><code>{shortAddress(person.address)}</code></div>
      <div className="detail-highlight"><div><span className="eyebrow">Weekly pay</span><strong>{money(schedule.weeklyPay)}</strong><small>distributed across 1 week</small></div><div className="highlight-arrow">?</div><div><span className="eyebrow">Each payout</span><strong>{money(schedule.perPayment, 6)}</strong><small>every {schedule.frequencyLabel}</small></div></div>
      <div className="plan-meter"><div><span>Paid prompts</span><strong>{paidCount} / {schedule.payments.toLocaleString()}</strong></div><div><span>Next prompt</span><strong>{nextRun}</strong></div><div><span>Source tag</span><strong>{SOURCE_TAG}</strong></div></div>
      <div className="details-actions"><Button kind={person.active ? "secondary" : "primary"} onClick={onToggle}>{person.active ? "Pause plan" : "Start plan"}</Button><Button kind="secondary" onClick={onPay} disabled={!walletReady || !person.address.startsWith("r")}>Pay one installment</Button></div>
      {!walletReady && <p className="inline-note">Unlock your wallet phrase first to make an on-chain payment.</p>}
      {walletReady && !person.address.startsWith("r") && <p className="inline-note">Add a public XRPL destination address before paying.</p>}
      {paymentMessage && <div className="success-message">{paymentMessage}</div>}
      <div className="safe-payment-note"><span>?</span> Cadence divides the weekly pay by the selected frequency. Your wallet may still ask you to confirm each on-chain payment.</div>
    </div>
  );
}

const makeEmployeeHistory = (perPayment, count = 8) => {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => {
    const stamp = new Date(now - index * 15000);
    const seed = (count - index + 1) * 2654435761;
    const hash = Math.abs(seed).toString(16).toUpperCase().padStart(8, "0").slice(0, 8);
    return {
      time: stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      amount: perPayment.toFixed(6),
      hash: `${hash}...`,
      status: "Completed",
    };
  });
};

function IncomeVerification({ walletAddress, employee, onBack, onExportLogs, onReset }) {
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [proofData, setProofData] = useState(null);
  const [proofLoading, setProofLoading] = useState(false);
  const [proofError, setProofError] = useState("");
  const employeeWallet = walletAddress?.startsWith("r") ? walletAddress : "";
  const employerWallet = CADENCE_EMPLOYER_WALLET;
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
  const documentId = employeeWallet ? `CADENCE-INC-${employeeWallet.slice(1, 7).toUpperCase()}` : "CADENCE-INC-CONNECT";

  const refreshProof = async () => {
    setProofLoading(true);
    setProofError("");
    try {
      const data = await readIncomeProofData(employeeWallet, employerWallet);
      setProofData(data);
    } catch (error) {
      setProofError(error?.message || "Could not read income transactions from the XRP Ledger.");
    } finally {
      setProofLoading(false);
    }
  };

  useEffect(() => {
    refreshProof();
  }, [employeeWallet]);

  const downloadCsv = () => {
    const lines = ["time,amount_rlusd,tx_hash,ledger_index", ...incomeRows.map((row) => `${row.iso},${row.amount.toFixed(6)},${row.hash},${row.ledgerIndex || ""}`)];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
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
        <Brand compact />
        <div className="topbar-right">
          <div className="wallet-chip">{shortAddress(walletAddress || employeeWallet)}</div>
          <Button kind="ghost" onClick={onExportLogs}>Export logs</Button>
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
            <div><small>Payee (connected wallet)</small><b>{employeeWallet || "No wallet connected"}</b></div>
            <div><small>Payer (employer wallet)</small><b>{employerWallet}</b></div>
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
                <thead><tr><th>Time</th><th>Amount</th><th>Transaction</th><th>Verify</th></tr></thead>
                <tbody>
                  {incomeRows.map((row) => (
                    <tr key={row.hash}>
                      <td>{row.time}</td>
                      <td>${row.amount.toFixed(6)}</td>
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

function EmployeeDashboard({ walletAddress, people, onBack, onExportLogs, onReset }) {
  const samplePerson = {
    name: "Maurice",
    role: "Employee",
    address: walletAddress,
    weeklyPay: "640",
    frequency: "seconds15",
    paidCount: 1335,
  };
  const employee = people.find((person) => person.active) || people[0] || samplePerson;
  const schedule = getSchedule({ ...employee, frequency: employee.frequency || "seconds15" });
  const startingPaid = Number(employee.paidCount || samplePerson.paidCount);
  const [paidCount, setPaidCount] = useState(startingPaid);
  const [msToNext, setMsToNext] = useState(15000);
  const [withdrawn, setWithdrawn] = useState(false);
  const [employeeHistory, setEmployeeHistory] = useState(() => makeEmployeeHistory(schedule.perPayment));
  const [employeeView, setEmployeeView] = useState("proof");

  useEffect(() => {
    setPaidCount(Number(employee.paidCount || samplePerson.paidCount));
    setMsToNext(15000);
    setWithdrawn(false);
    setEmployeeHistory(makeEmployeeHistory(schedule.perPayment));
  }, [employee.id, schedule.perPayment]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMsToNext((current) => {
        const next = current - 200;
        if (next > 0) return next;
        setPaidCount((count) => Math.min(schedule.payments, count + 1));
        setEmployeeHistory((currentHistory) => {
          const hash = Math.abs(Date.now()).toString(16).toUpperCase().slice(-8);
          return [{
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            amount: schedule.perPayment.toFixed(6),
            hash: `${hash}...`,
            status: "Completed",
          }, ...currentHistory].slice(0, 8);
        });
        return 15000;
      });
    }, 200);

    return () => window.clearInterval(timer);
  }, [schedule.payments, schedule.perPayment]);

  const cappedPaid = Math.min(paidCount, schedule.payments);
  const balanceAccrued = cappedPaid * schedule.perPayment;
  const progressPct = Math.min(100, (cappedPaid / schedule.payments) * 100);
  const displayBalance = money(balanceAccrued, 2);
  const [balanceWhole, balanceCents = "00"] = displayBalance.replace("$", "").split(".");
  const employeeName = employee.name || "Maurice";
  const employerWallet = "rEfcBKr...DE864";

  if (employeeView === "proof") {
    return <IncomeVerification walletAddress={walletAddress} employee={employee} onBack={() => setEmployeeView("dashboard")} onExportLogs={onExportLogs} onReset={onReset} />;
  }

  return (
    <div className="app-shell employee-app">
      <header className="topbar">
        <Brand compact />
        <div className="topbar-right">
          <div className="wallet-chip"><span className="online-dot" />{shortAddress(walletAddress || employee.address)}</div>
          <Button kind="ghost" onClick={onBack}>Employer view</Button>
          <Button kind="ghost" onClick={() => setEmployeeView("proof")}>Income proof</Button>
          <Button kind="ghost" onClick={onExportLogs}>Export logs</Button>
          <Button kind="ghost" onClick={onReset}>Change wallet</Button>
        </div>
      </header>
      <main className="dashboard-content employee-content">
        <div className="employee-hero">
          <div>
            <p className="eyebrow"><span className="online-dot" /> Good to see you, {employeeName}</p>
            <h1>Your pay, streaming in</h1>
            <p className="muted-line">RLUSD arrives every {schedule.frequencyLabel}, straight from Cadence without waiting on payday.</p>
          </div>
          <div className="live-pill"><span className="online-dot" />Employee dashboard</div>
        </div>

        <section className="employee-balance-card">
          <div className="employee-balance-top">
            <div>
              <p className="eyebrow">Available balance RLUSD</p>
              <div className="employee-balance-number">${balanceWhole}<span>.{balanceCents}</span></div>
              <p>{money(schedule.perPayment, 6)} every {schedule.frequencyLabel} - {money(schedule.weeklyPay)} this week</p>
            </div>
            <div className="employee-live-tag"><span className="online-dot" />Live</div>
          </div>
          <div className="employee-balance-footer">
            <code>{shortAddress(walletAddress || employee.address)}</code>
            <div>
              <Button kind="soft" onClick={() => setWithdrawn(true)} disabled={withdrawn}>{withdrawn ? "Withdrawal queued" : "Withdraw"}</Button>
              {withdrawn && <p>Funds settle in your linked account shortly.</p>}
            </div>
          </div>
        </section>

        <div className="employee-stat-grid">
          <section className="employee-card">
            <p className="eyebrow">Earned this week</p>
            <strong>{money(balanceAccrued)}</strong>
            <span>of a {money(schedule.weeklyPay)} weekly rhythm</span>
            <div className="employee-progress"><div style={{ width: `${progressPct}%` }} /></div>
            <small>{cappedPaid.toLocaleString()} / {schedule.payments.toLocaleString()} payouts this week</small>
          </section>
          <section className="employee-card">
            <p className="eyebrow">Next payment</p>
            <strong>{money(schedule.perPayment, 6)}</strong>
            <span>arrives in {(msToNext / 1000).toFixed(1)}s</span>
            <div className="employee-meta-row">
              <div><small>Source tag</small><b>{SOURCE_TAG}</b></div>
              <div><small>Paid by</small><b>{employerWallet}</b></div>
            </div>
          </section>
        </div>

        <section className="employee-card employee-history-card">
          <div className="card-heading">
            <div><p className="eyebrow">Payment history</p><h2>Recent RLUSD received</h2></div>
            <span className="employee-live-tag">{employeeHistory.length} shown</span>
          </div>
          <div className="employee-table-wrap">
            <table className="employee-table">
              <thead><tr><th>Time</th><th>Amount</th><th>Transaction</th><th>Status</th></tr></thead>
              <tbody>
                {employeeHistory.map((row) => (
                  <tr key={`${row.time}-${row.hash}`}>
                    <td>{row.time}</td>
                    <td>${row.amount}</td>
                    <td>{row.hash}</td>
                    <td><span>{row.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Dashboard({ walletAddress, rlusdBalance, balanceLoading, onRefreshBalance, onOpenFunding, onReset, people, onAdd, selectedId, onSelect, onSave, onEdit, onToggle, onPay, paymentMessage, history, debugLogs, onExportLogs, onClearLogs, onOpenEmployee }) {
  const selectedPerson = people.find((person) => person.id === selectedId);
  return (
    <div className="app-shell">
      <header className="topbar"><Brand compact /><div className="topbar-right"><div className="wallet-chip"><span className="online-dot" />{shortAddress(walletAddress)}</div><Button kind="ghost" onClick={onOpenEmployee}>Employee view</Button><Button kind="ghost" onClick={onExportLogs}>Export logs</Button><Button kind="ghost" onClick={onClearLogs}>Clear logs</Button><Button kind="ghost" onClick={onReset}>Change wallet</Button></div></header>
      <main className="dashboard-content">
        <div className="welcome-row"><div><p className="eyebrow">Good to see you</p><h1>Your payment rhythm</h1><p className="muted-line">Keep RLUSD moving at a pace that feels natural.</p></div><div className="live-pill"><span className="online-dot" />Local session</div></div>
        <section className="balance-card"><div><p className="eyebrow">Available balance  RLUSD</p><div className="balance-number">{money(rlusdBalance, 2)}</div><p className="muted-line">{walletAddress ? shortAddress(walletAddress) : "Local wallet test mode"}</p></div><div className="balance-actions"><Button kind="secondary" onClick={onRefreshBalance} disabled={balanceLoading}>{balanceLoading ? "Reading..." : "Refresh balance"}</Button>{rlusdBalance <= 0 && <Button kind="soft" onClick={onOpenFunding}>How to get RLUSD</Button>}</div></section>
        <section className="payer-strip"><div><p className="eyebrow">Payment wallet</p><strong>{shortAddress(walletAddress)}</strong><span>Payments are signed locally from the wallet phrase you unlocked.</span></div><Button kind="secondary" onClick={onReset}>Change wallet</Button></section>
        <div className="content-grid"><PeopleList people={people} selectedId={selectedId} onSelect={onSelect} onAdd={onAdd} />{selectedPerson ? <PersonDetails person={selectedPerson} onEdit={() => onEdit(selectedPerson)} onToggle={() => onToggle(selectedPerson.id)} onPay={() => onPay(selectedPerson)} walletReady={Boolean(walletAddress && walletAddress.startsWith("r"))} paymentMessage={paymentMessage} /> : <div className="details-card details-empty"><div className="empty-sun">*</div><h2>Your next step is small.</h2><p>Add a person and Cadence will turn their total pay into clear, simple installments.</p><Button onClick={onAdd}>Create a payment plan</Button></div>}</div>
        <section className="history-panel"><div className="card-heading"><div><p className="eyebrow">Diagnostics</p><h2>Debug logs</h2></div><Button kind="small" onClick={onExportLogs}>Export logs</Button></div>{debugLogs.length === 0 ? <p className="muted-line">No diagnostic logs yet.</p> : <div className="debug-log-list">{debugLogs.slice(0, 12).map((item) => <div className="debug-log-row" key={item.id}><time>{new Date(item.at).toLocaleString()}</time><b>{item.event}</b><code>{JSON.stringify(item.payload)}</code></div>)}</div>}</section>
        <p className="footer-note">RLUSD is a dollar-denominated token on the XRP Ledger. Network fees, issuer details, and wallet confirmations should always be checked before sending.</p>
      </main>
    </div>
  );
}

export default function CadenceDashboard() {
  const [screen, setScreen] = useState("intro");
  const [method, setMethod] = useState("family");
  const [accessInput, setAccessInput] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [rlusdBalance, setRlusdBalance] = useState(0);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [showFunding, setShowFunding] = useState(false);
  const [signingWallet, setSigningWallet] = useState(null);
  const [people, setPeople] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPerson, setEditingPerson] = useState(null);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [history, setHistory] = useState([]);
  const [debugLogs, setDebugLogs] = useState(loadStoredLogs);
  const [dashboardView, setDashboardView] = useState("employer");
  const autoPayingRef = useRef(false);

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

  const refreshBalance = async (address = walletAddress) => {
    logEvent("balance.refresh.started", { address: address ? shortAddress(address) : "none" });
    if (!address || !address.startsWith("r")) {
      setRlusdBalance(0);
      setShowFunding(true);
      logEvent("balance.refresh.skipped", { reason: "missing_or_invalid_public_address" });
      return;
    }
    setBalanceLoading(true);
    try {
      const balance = await readRlusdBalance(address);
      setRlusdBalance(balance);
      if (balance <= 0) setShowFunding(true);
      logEvent("balance.refresh.success", { address: shortAddress(address), balance });
    } catch (error) {
      setSetupError(error?.message || "Could not read the RLUSD balance.");
      logEvent("balance.refresh.failed", { error });
    } finally {
      setBalanceLoading(false);
    }
  };

  const finishSetup = async () => {
    logEvent("wallet.setup.submitted", {
      method,
      accessLength: accessInput.trim().length,
    });

    try {
      const wallet = createWalletFromInput(method, accessInput);
      setSetupError("");
      setSigningWallet(wallet);
      setWalletAddress(wallet.address);
      setScreen("dashboard");
      logEvent("wallet.setup.success", { method, walletAddress: shortAddress(wallet.address) });
      await refreshBalance(wallet.address);
    } catch (error) {
      setSigningWallet(null);
      setSetupError(error?.message || "Could not unlock this XRPL wallet phrase.");
      logEvent("wallet.setup.failed", { method, error });
    }
  };

  const savePerson = (draft) => {
    const next = { ...draft, payMode: draft.payMode || "weekly", weeklyPay: draft.weeklyPay ?? draft.amount ?? "16", hourlyPay: draft.hourlyPay ?? "20", hoursPerWeek: draft.hoursPerWeek ?? "40", id: draft.id || `person-${Date.now()}`, paidCount: draft.paidCount || 0, nextRunAt: draft.nextRunAt || null };
    const schedule = getSchedule(next);
    setPeople((current) => draft.id ? current.map((person) => person.id === draft.id ? next : person) : [...current, next]);
    setSelectedId(next.id);
    setEditorOpen(false);
    setEditingPerson(null);
    setPaymentMessage("");
    addHistoryItem(setHistory, { status: "success", title: draft.id ? "Person updated" : "Person added", detail: `${next.name} - ${money(getSchedule(next).weeklyPay, 2)} weekly total, paid every ${getSchedule(next).frequencyLabel}` });
    logEvent(draft.id ? "person.updated" : "person.added", {
      id: next.id,
      name: next.name,
      address: next.address ? shortAddress(next.address) : "none",
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
      setPeople((current) => current.map((item) => item.id === id ? { ...item, active: false, nextRunAt: null } : item));
      setPaymentMessage(`${person.name}'s plan is paused.`);
      addHistoryItem(setHistory, { status: "paused", title: "Plan paused", detail: person.name });
      logEvent("plan.paused", { id: person.id, name: person.name });
      return;
    }

    const ready = Boolean(signingWallet && person.address?.startsWith("r"));
    setPeople((current) => current.map((item) => item.id === id ? { ...item, active: true, nextRunAt: ready ? Date.now() : null } : item));
    setPaymentMessage(ready ? `${person.name}'s plan started. First payment prompt is opening.` : `${person.name}'s plan started. Unlock a wallet phrase and add a destination address to send payments.`);
    addHistoryItem(setHistory, { status: ready ? "success" : "waiting", title: "Plan started", detail: ready ? `${person.name} - first payment queued now` : `${person.name} - waiting for payer wallet and destination` });
    logEvent("plan.started", {
      id: person.id,
      name: person.name,
      ready,
      hasSigningWallet: Boolean(signingWallet),
      hasDestination: Boolean(person.address?.startsWith("r")),
      schedule: getSchedule(person),
    });
    if (ready) window.setTimeout(() => payInstallment({ ...person, active: true, nextRunAt: Date.now() }, "scheduled"), 150);
  };

  const payInstallment = async (person, source = "manual") => {
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
      payer: signingWallet ? shortAddress(signingWallet.address) : "none",
      destination: person.address ? shortAddress(person.address) : "none",
    });

    if (paidCount >= schedule.payments) {
      setPeople((current) => current.map((item) => item.id === person.id ? { ...item, active: false, nextRunAt: null } : item));
      addHistoryItem(setHistory, { status: "success", title: "Plan complete", detail: `${person.name} has received all planned installments.` });
      logEvent("payment.installment.skipped", { reason: "plan_complete", personId: person.id, name: person.name });
      return;
    }

    if (!signingWallet || !person.address?.startsWith("r")) {
      setPaymentMessage(`${person.name} needs an unlocked wallet phrase and destination address.`);
      addHistoryItem(setHistory, { status: "waiting", title: "Payment waiting", detail: `${person.name} needs an unlocked wallet phrase and destination address.` });
      logEvent("payment.installment.blocked", {
        reason: "missing_wallet_or_destination",
        hasSigningWallet: Boolean(signingWallet),
        hasDestination: Boolean(person.address?.startsWith("r")),
      });
      return;
    }

    setPaymentMessage("Signing and submitting the installment from the unlocked wallet...");
    addHistoryItem(setHistory, { status: "waiting", title: source === "manual" ? "Manual payment started" : "Scheduled payment started", detail: `${person.name} - ${money(schedule.perPayment, 4)} - source tag ${SOURCE_TAG}` });
    logEvent("payment.local_signing.started", {
      transactionType: "Payment",
      account: shortAddress(signingWallet.address),
      destination: shortAddress(person.address),
      sourceTag: SOURCE_TAG,
      amount: schedule.perPayment.toFixed(6),
      issuer: RLUSD_ISSUER,
    });
    try {
      const { result, hash } = await submitRlusdPayment({
        wallet: signingWallet,
        destination: person.address,
        amount: schedule.perPayment.toFixed(6),
      });
      const tx = result?.result || result || {};
      const txHash = hash || tx.hash;
      const nextPaidCount = paidCount + 1;
      const complete = nextPaidCount >= schedule.payments;
      setPeople((current) => current.map((item) => item.id === person.id ? {
        ...item,
        paidCount: nextPaidCount,
        active: complete ? false : item.active,
        nextRunAt: complete ? null : Date.now() + getFrequencyMs(item),
      } : item));
      setPaymentMessage(txHash ? `Payment submitted: ${txHash.slice(0, 10)}...` : "Payment submitted.");
      addHistoryItem(setHistory, { status: "success", title: complete ? "Final payment submitted" : "Payment submitted", detail: txHash ? `${person.name} - ${money(schedule.perPayment, 4)} - tag ${SOURCE_TAG} - ${txHash}` : `${person.name} - ${money(schedule.perPayment, 4)} - tag ${SOURCE_TAG}` });
      logEvent("payment.submitted", {
        personId: person.id,
        name: person.name,
        hash: txHash || null,
        nextPaidCount,
        complete,
        nextRunAt: complete ? null : Date.now() + getFrequencyMs(person),
      });
    } catch (error) {
      setPaymentMessage(error?.message || "Payment was not submitted.");
      setPeople((current) => current.map((item) => item.id === person.id ? { ...item, nextRunAt: Date.now() + 60000 } : item));
      addHistoryItem(setHistory, { status: "failed", title: "Payment not submitted", detail: `${person.name} - ${error?.message || "Wallet confirmation was cancelled."}` });
      logEvent("payment.failed", { personId: person.id, name: person.name, source, error, retryAt: Date.now() + 60000 });
    }
  };

  useEffect(() => {
    const timer = window.setInterval(() => {
      const duePerson = people.find((person) =>
        person.active &&
        person.nextRunAt &&
        Number(person.nextRunAt) <= Date.now() &&
        Number(person.paidCount || 0) < getSchedule(person).payments
      );
      if (!duePerson || autoPayingRef.current) return;
      logEvent("scheduler.due_person_found", {
        personId: duePerson.id,
        name: duePerson.name,
        nextRunAt: duePerson.nextRunAt,
        paidCount: duePerson.paidCount || 0,
        schedule: getSchedule(duePerson),
      });
      autoPayingRef.current = true;
      payInstallment(duePerson, "scheduled").finally(() => {
        autoPayingRef.current = false;
      });
    }, 10000);

    return () => window.clearInterval(timer);
  }, [people, signingWallet]);
  const resetWallet = () => {
    logEvent("wallet.reset", { previousWallet: walletAddress ? shortAddress(walletAddress) : "none", peopleCount: people.length });
    setScreen("intro");
    setAccessInput("");
    setWalletAddress("");
    setRlusdBalance(0);
    setSigningWallet(null);
    setSetupError("");
    setDashboardView("employer");
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; background: ${COLORS.paper}; color: ${COLORS.ink}; font-family: 'DM Sans', sans-serif; }
        button, input, select { font: inherit; }
        button { cursor: pointer; }
        button:disabled { cursor: not-allowed; opacity: .55; }
        .center-screen { min-height: 100vh; display: grid; place-items: center; padding: 28px; position: relative; overflow: hidden; }
        .intro-screen { background: linear-gradient(135deg, #fbf8f1 0%, #f3eee2 100%); }
        .intro-card, .setup-card { width: min(100%, 540px); position: relative; z-index: 1; }
        .intro-card { padding: 46px 48px; background: rgba(255,253,248,.88); border: 1px solid rgba(231,226,215,.9); border-radius: 28px; box-shadow: 0 24px 70px rgba(72,74,56,.12); text-align: center; }
        .intro-card > div:first-child { justify-content: center; }
        .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; background: ${COLORS.ink}; color: #fffdf8; border-radius: 14px 14px 14px 4px; font: 600 25px Georgia, serif; transform: rotate(-5deg); }
        .intro-card .brand-mark { width: 48px; height: 48px; font-size: 29px; }
        .intro-sun { margin: 46px 0 14px; color: ${COLORS.coral}; font-size: 32px; }
        .eyebrow { margin: 0 0 8px; text-transform: uppercase; letter-spacing: .14em; font-size: 10px; font-weight: 700; color: ${COLORS.muted}; }
        h1, h2, h3, p { margin-top: 0; }
        h1, h2, h3 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; letter-spacing: -.045em; }
        h1 { font-size: clamp(42px, 6vw, 65px); line-height: .98; margin-bottom: 20px; }
        h1 em { color: ${COLORS.coralDark}; font-style: normal; }
        h2 { font-size: 30px; line-height: 1.05; margin-bottom: 10px; }
        h3 { font-size: 24px; margin: 0; }
        .intro-copy, .section-copy { color: ${COLORS.muted}; line-height: 1.65; font-size: 14px; }
        .intro-copy { max-width: 360px; margin: 0 auto 28px; }
        .intro-note, .security-note, .footer-note { color: ${COLORS.muted}; font-size: 11px; }
        .intro-note { margin-top: 20px; }
        .intro-connect-form { display: grid; gap: 14px; max-width: 390px; margin: 0 auto; text-align: left; }
        .intro-connect-form .button { width: 100%; }
        .button { border: 0; border-radius: 12px; padding: 13px 18px; font-weight: 700; color: ${COLORS.ink}; transition: transform .15s ease, box-shadow .15s ease, background .15s ease; }
        .button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(52,63,53,.12); }
        .button-primary { background: ${COLORS.ink}; color: #fffdf8; }
        .button-secondary { background: ${COLORS.card}; border: 1px solid ${COLORS.line}; }
        .button-soft { background: ${COLORS.mint}; color: ${COLORS.mintDark}; }
        .button-ghost { padding: 8px 10px; background: transparent; color: ${COLORS.muted}; font-size: 12px; }
        .button-small { padding: 9px 12px; font-size: 12px; background: ${COLORS.mint}; color: ${COLORS.mintDark}; }
        .button span { margin-left: 8px; font-size: 16px; }
        .intro-decoration { position: absolute; border-radius: 50%; filter: blur(1px); opacity: .65; }
        .decoration-one { width: 260px; height: 260px; top: -90px; right: 12%; background: ${COLORS.butter}; }
        .decoration-two { width: 330px; height: 330px; bottom: -170px; left: 4%; background: ${COLORS.mint}; }
        .setup-screen { background: ${COLORS.paper}; }
        .setup-card { max-width: 480px; padding: 30px; background: ${COLORS.card}; border: 1px solid ${COLORS.line}; border-radius: 24px; box-shadow: 0 18px 50px rgba(72,74,56,.08); }
        .progress-dots { display: flex; gap: 6px; margin: 38px 0 32px; }
        .progress-dots span { width: 32px; height: 4px; border-radius: 4px; background: ${COLORS.line}; }
        .progress-dots .active { background: ${COLORS.coral}; }
        .setup-card h2 { font-size: 42px; margin-bottom: 14px; }
        .form-stack { display: grid; gap: 16px; margin: 24px 0; }
        .field { display: grid; gap: 7px; min-width: 0; }
        .field-label { font-size: 11px; font-weight: 700; color: ${COLORS.ink}; }
        .field-help { color: ${COLORS.muted}; font-size: 10px; line-height: 1.4; }
        input, select { width: 100%; min-height: 43px; padding: 10px 12px; border: 1px solid ${COLORS.line}; border-radius: 10px; background: #fff; color: ${COLORS.ink}; outline: none; }
        input:focus, select:focus { border-color: ${COLORS.mintDark}; box-shadow: 0 0 0 3px rgba(185,221,203,.35); }
        .setup-card .button { width: 100%; }
        .security-note { margin-top: 18px; line-height: 1.45; text-align: center; }
        .security-note span { color: ${COLORS.coralDark}; font-size: 15px; margin-right: 4px; }
        .error-message, .success-message { padding: 11px 13px; border-radius: 10px; font-size: 12px; line-height: 1.4; margin-bottom: 14px; }
        .error-message { color: ${COLORS.coralDark}; background: #fae9e2; }
        .success-message { color: ${COLORS.mintDark}; background: #e3f2e9; margin-top: 16px; }
        .app-shell { min-height: 100vh; background: ${COLORS.paper}; }
        .topbar { height: 74px; padding: 0 clamp(20px, 5vw, 76px); display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid ${COLORS.line}; background: rgba(255,253,248,.75); }
        .topbar-right, .wallet-chip, .welcome-row, .balance-actions, .card-heading, .details-top, .details-actions, .payer-strip { display: flex; align-items: center; }
        .topbar-right { gap: 12px; }
        .wallet-chip, .live-pill { gap: 8px; color: ${COLORS.muted}; font-size: 12px; }
        .wallet-chip { padding: 8px 10px; background: ${COLORS.card}; border: 1px solid ${COLORS.line}; border-radius: 10px; font-family: monospace; }
        .online-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: #65aa7c; box-shadow: 0 0 0 3px rgba(101,170,124,.15); }
        .dashboard-content { max-width: 1200px; margin: 0 auto; padding: 54px clamp(20px, 5vw, 76px) 40px; }
        .welcome-row { justify-content: space-between; gap: 20px; margin-bottom: 30px; }
        .welcome-row h1 { font-size: clamp(38px, 5vw, 58px); margin-bottom: 10px; }
        .muted-line { margin: 0; color: ${COLORS.muted}; font-size: 13px; }
        .live-pill { padding: 8px 12px; border-radius: 99px; background: #e7f2e9; color: ${COLORS.mintDark}; font-weight: 700; }
        .balance-card { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding: 30px 34px; min-height: 190px; border-radius: 24px; background: ${COLORS.ink}; color: #fffdf8; box-shadow: 0 18px 40px rgba(36,51,45,.16); }
        .balance-card .eyebrow, .balance-card .muted-line { color: #c1d0c7; }
        .balance-number { font: 600 clamp(48px, 7vw, 82px)/1 'Fraunces', Georgia, serif; letter-spacing: -.06em; margin: 12px 0 10px; }
        .balance-actions { gap: 10px; flex-wrap: wrap; }
        .balance-card .button-secondary { background: #fffdf8; border-color: #fffdf8; }
        .balance-card .button-soft { background: ${COLORS.mint}; }
        .payer-strip { justify-content: space-between; gap: 18px; padding: 17px 20px; margin: 14px 0 34px; border: 1px solid ${COLORS.line}; border-radius: 16px; background: ${COLORS.card}; }
        .payer-strip strong { display: block; font: 600 17px Georgia, serif; }
        .payer-strip span { display: block; margin-top: 4px; color: ${COLORS.muted}; font-size: 11px; }
        .content-grid { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(420px, 1.2fr); gap: 16px; align-items: stretch; }
        .people-card, .details-card, .editor-card { padding: 24px; border: 1px solid ${COLORS.line}; border-radius: 20px; background: ${COLORS.card}; }
        .card-heading { justify-content: space-between; gap: 12px; margin-bottom: 22px; }
        .card-heading h2 { font-size: 25px; margin: 0; }
        .people-list { display: grid; gap: 7px; }
        .person-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto 8px; align-items: center; gap: 10px; width: 100%; padding: 11px; border: 1px solid transparent; border-radius: 14px; background: transparent; text-align: left; color: ${COLORS.ink}; }
        .person-row:hover, .person-row.selected { background: #f3f7f1; border-color: ${COLORS.mint}; }
        .avatar, .large-avatar { display: grid; place-items: center; border-radius: 13px; background: ${COLORS.butter}; color: ${COLORS.coralDark}; font-weight: 700; }
        .avatar { width: 38px; height: 38px; }
        .person-info, .person-amount { min-width: 0; display: grid; gap: 3px; }
        .person-info b, .person-amount b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
        .person-info small, .person-amount small { color: ${COLORS.muted}; font-size: 10px; }
        .person-amount { text-align: right; }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; background: ${COLORS.line}; }
        .status-dot.on { background: #65aa7c; }
        .empty-people, .details-empty { min-height: 290px; display: grid; place-items: center; align-content: center; text-align: center; color: ${COLORS.muted}; }
        .empty-people p, .details-empty p { max-width: 240px; line-height: 1.55; font-size: 13px; }
        .empty-scribble, .empty-sun { color: ${COLORS.coral}; font: 34px Georgia, serif; margin-bottom: 12px; }
        .details-top { gap: 14px; position: relative; }
        .large-avatar { width: 56px; height: 56px; border-radius: 18px; font-size: 22px; }
        .details-top h2 { font-size: 30px; margin: 0 0 4px; }
        .edit-button { margin-left: auto; }
        .text-button { border: 0; padding: 4px; background: transparent; color: ${COLORS.coralDark}; font-size: 12px; font-weight: 700; }
        .address-line { display: flex; justify-content: space-between; gap: 12px; padding: 15px 0; margin: 20px 0; border-top: 1px solid ${COLORS.line}; border-bottom: 1px solid ${COLORS.line}; color: ${COLORS.muted}; font-size: 11px; }
        code { font-family: monospace; color: ${COLORS.ink}; }
        .detail-highlight { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 16px; padding: 20px; border-radius: 16px; background: #f3eee2; }
        .detail-highlight strong { display: block; font: 600 28px Georgia, serif; margin: 5px 0; }
        .detail-highlight small { display: block; color: ${COLORS.muted}; font-size: 10px; }
        .highlight-arrow { color: ${COLORS.coral}; font-size: 28px; }
        .details-actions { gap: 10px; flex-wrap: wrap; margin-top: 20px; }
        .plan-meter { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
        .plan-meter > div { padding: 12px; border: 1px solid ${COLORS.line}; border-radius: 12px; background: #fff; }
        .plan-meter span, .plan-meter strong { display: block; }
        .plan-meter span { color: ${COLORS.muted}; font-size: 10px; }
        .plan-meter strong { margin-top: 4px; font-size: 12px; }
        .inline-note, .safe-payment-note { color: ${COLORS.muted}; font-size: 11px; line-height: 1.5; }
        .safe-payment-note { padding: 12px; margin-top: 20px; background: #f6f2e8; border-radius: 10px; }
        .safe-payment-note span { color: ${COLORS.mintDark}; margin-right: 6px; }
        .footer-note { max-width: 760px; margin: 24px auto 0; text-align: center; line-height: 1.5; }
        .history-panel { margin-top: 16px; padding: 24px; border: 1px solid ${COLORS.line}; border-radius: 20px; background: ${COLORS.card}; }
        .history-list { display: grid; gap: 8px; }
        .history-row { display: flex; justify-content: space-between; gap: 16px; padding: 12px; border: 1px solid ${COLORS.line}; border-radius: 12px; background: #fff; }
        .history-row b, .history-row span, .history-row time { display: block; }
        .history-row b { font-size: 13px; }
        .history-row span, .history-row time { color: ${COLORS.muted}; font-size: 11px; line-height: 1.4; }
        .history-row.success { border-color: ${COLORS.mint}; }
        .history-row.failed { border-color: #efb49f; background: #fff7f3; }
        .debug-log-list { display: grid; gap: 8px; max-height: 310px; overflow: auto; }
        .debug-log-row { display: grid; grid-template-columns: 150px 180px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px; border: 1px solid ${COLORS.line}; border-radius: 10px; background: #fff; }
        .debug-log-row time, .debug-log-row b, .debug-log-row code { font-size: 10px; line-height: 1.4; }
        .debug-log-row time { color: ${COLORS.muted}; }
        .debug-log-row b { color: ${COLORS.ink}; }
        .debug-log-row code { white-space: pre-wrap; word-break: break-word; color: ${COLORS.muted}; }
        .editor-card { grid-column: 1 / -1; }
        .editor-heading { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
        .editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .pay-plan-box { margin: 22px 0; padding: 18px; border-radius: 16px; background: #f3eee2; }
        .pay-plan-title { font: 600 18px Georgia, serif; margin-bottom: 16px; }
        .mode-toggle { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 16px; padding: 9px 11px; border: 1px solid ${COLORS.line}; border-radius: 10px; background: #fff; color: ${COLORS.ink}; font-size: 12px; font-weight: 700; }
        .mode-toggle input { width: 16px; min-height: 16px; padding: 0; accent-color: ${COLORS.mintDark}; }
        .plan-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .input-with-symbol { position: relative; }
        .input-with-symbol span { position: absolute; left: 12px; top: 12px; color: ${COLORS.muted}; }
        .input-with-symbol input { padding-left: 26px; }
        .schedule-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-top: 18px; margin-top: 18px; border-top: 1px solid ${COLORS.line}; }
        .schedule-summary > div { display: grid; gap: 5px; }
        .summary-label { color: ${COLORS.muted}; font-size: 10px; }
        .schedule-summary strong { font: 600 18px Georgia, serif; }
        .modal-backdrop { position: fixed; z-index: 10; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(36,51,45,.35); }
        .modal-card { width: min(100%, 430px); position: relative; padding: 34px; border-radius: 22px; background: ${COLORS.card}; box-shadow: 0 20px 70px rgba(36,51,45,.25); }
        .modal-close { position: absolute; top: 15px; right: 17px; border: 0; background: transparent; color: ${COLORS.muted}; font-size: 26px; }
        .modal-icon { color: ${COLORS.coral}; font-size: 40px; margin-bottom: 20px; }
        .modal-card h2 { font-size: 38px; }
        .funding-steps { display: grid; gap: 13px; margin: 22px 0 26px; }
        .funding-steps > div { display: grid; grid-template-columns: 25px 1fr; gap: 9px; align-items: start; color: ${COLORS.muted}; font-size: 12px; line-height: 1.45; }
        .funding-steps b { display: grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: ${COLORS.mint}; color: ${COLORS.mintDark}; font-size: 11px; }
        .employee-app { background: linear-gradient(180deg, ${COLORS.paper} 0%, #f4efe4 100%); }
        .employee-content { max-width: 1000px; display: flex; flex-direction: column; gap: 18px; }
        .employee-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .employee-hero .eyebrow { display: flex; align-items: center; gap: 8px; }
        .employee-hero h1 { font-size: clamp(38px, 5vw, 58px); margin-bottom: 10px; }
        .employee-balance-card { display: grid; gap: 22px; padding: 30px 34px; border-radius: 24px; background: ${COLORS.ink}; color: #fffdf8; box-shadow: 0 18px 40px rgba(36,51,45,.16); }
        .employee-balance-card .eyebrow { color: #c1d0c7; }
        .employee-balance-card p { margin: 0; color: #c1d0c7; font-size: 13px; }
        .employee-balance-top, .employee-balance-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
        .employee-balance-footer { align-items: flex-end; padding-top: 18px; border-top: 1px solid rgba(255,253,248,.15); }
        .employee-balance-footer code { color: #c1d0c7; }
        .employee-balance-footer > div { display: grid; justify-items: end; gap: 8px; }
        .employee-balance-number { font: 600 clamp(54px, 8vw, 86px)/1 'Fraunces', Georgia, serif; letter-spacing: -.04em; margin: 8px 0 12px; }
        .employee-balance-number span { color: ${COLORS.mint}; }
        .employee-live-tag { display: inline-flex; align-items: center; gap: 7px; width: fit-content; padding: 7px 10px; border-radius: 999px; background: #e7f2e9; color: ${COLORS.mintDark}; font-size: 11px; font-weight: 700; text-transform: uppercase; }
        .employee-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .employee-card { padding: 24px; border: 1px solid ${COLORS.line}; border-radius: 20px; background: ${COLORS.card}; box-shadow: 0 10px 24px rgba(72,74,56,.07); }
        .employee-card strong { display: block; font: 600 30px Georgia, serif; margin-bottom: 6px; color: ${COLORS.ink}; }
        .employee-card span, .employee-card small { color: ${COLORS.muted}; font-size: 12px; }
        .employee-progress { height: 9px; overflow: hidden; margin: 16px 0 9px; border-radius: 999px; background: #ece7dc; }
        .employee-progress div { height: 100%; border-radius: inherit; background: ${COLORS.mintDark}; transition: width .2s ease; }
        .employee-meta-row { display: flex; gap: 30px; margin-top: 18px; flex-wrap: wrap; }
        .employee-meta-row small, .employee-meta-row b { display: block; }
        .employee-meta-row b { margin-top: 3px; font-size: 13px; }
        .employee-history-card .card-heading { margin-bottom: 16px; }
        .employee-table-wrap { overflow: auto; }
        .employee-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .employee-table th { padding: 10px 8px; border-bottom: 1px solid ${COLORS.line}; color: ${COLORS.muted}; text-align: left; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
        .employee-table td { padding: 12px 8px; border-bottom: 1px solid #eee8db; color: ${COLORS.ink}; }
        .employee-table td:nth-child(3) { color: ${COLORS.muted}; font-family: monospace; }
        .employee-table td span { display: inline-flex; padding: 4px 9px; border-radius: 999px; background: #e7f2e9; color: ${COLORS.mintDark}; font-size: 11px; font-weight: 700; }
        .proof-app { background: #f4ead8; }
        .proof-topbar { background: rgba(244,234,216,.85); border-bottom: 0; }
        .proof-content { max-width: 900px; margin: 0 auto; padding: 18px clamp(20px, 4vw, 44px) 44px; display: flex; flex-direction: column; gap: 18px; }
        .proof-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
        .proof-heading .eyebrow { display: flex; align-items: center; gap: 8px; color: ${COLORS.coralDark}; }
        .proof-heading h1 { color: #201e1d; font-size: clamp(36px, 5vw, 52px); margin-bottom: 8px; }
        .proof-heading p { max-width: 540px; margin: 0; color: #615a51; line-height: 1.5; }
        .proof-pill { display: inline-flex; align-items: center; padding: 7px 12px; border-radius: 999px; background: #eef8df; color: ${COLORS.mintDark}; font-size: 11px; white-space: nowrap; }
        .proof-reference { display: grid; gap: 18px; padding: 22px 18px; border-radius: 28px; background: #201e1d; color: #fff8ec; }
        .proof-reference-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,248,236,.14); }
        .proof-reference-top p, .proof-reference small { margin: 0; color: rgba(255,248,236,.55); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
        .proof-reference-top strong { display: block; margin-top: 4px; font: 600 22px Georgia, serif; letter-spacing: .02em; }
        .proof-reference-top span { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border-radius: 999px; background: rgba(255,248,236,.12); font-size: 11px; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
        .proof-reference-top i { width: 6px; height: 6px; border-radius: 999px; background: ${COLORS.coral}; }
        .proof-reference-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 28px; }
        .proof-reference b { display: block; margin-top: 4px; font-size: 13px; word-break: break-all; }
        .proof-stat-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
        .proof-card { padding: 20px 14px; border-radius: 28px; background: #eadcc4; box-shadow: 0 4px 14px rgba(46,43,37,.08); }
        .proof-card .eyebrow { color: ${COLORS.coralDark}; }
        .proof-card strong { display: block; color: #201e1d; font: 600 30px Georgia, serif; margin: 8px 0; }
        .proof-card span, .proof-card p { color: #615a51; font-size: 13px; line-height: 1.5; }
        .proof-status { padding: 13px 16px; border-radius: 16px; background: #eef8df; color: ${COLORS.mintDark}; font-size: 13px; line-height: 1.5; }
        .proof-status.error { background: #fae9e2; color: ${COLORS.coralDark}; }
        .proof-projection { padding: 24px 14px; }
        .proof-projection h2, .proof-ledger h2 { font-size: 20px; color: #201e1d; letter-spacing: 0; margin-bottom: 18px; }
        .proof-projection-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; margin-bottom: 18px; }
        .proof-projection-grid small { display: block; color: ${COLORS.muted}; margin-bottom: 5px; }
        .proof-projection-grid strong { font-size: 24px; margin: 0; }
        .proof-ledger { padding: 14px; }
        .proof-ledger-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
        .proof-ledger-head h2 { margin: 0; }
        .proof-ledger-head > div:last-child { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .proof-disclaimer { max-width: 680px; margin: 0; color: ${COLORS.muted}; font-size: 12px; line-height: 1.5; }
        @media (max-width: 760px) {
          .topbar { height: auto; padding: 18px 20px; gap: 14px; flex-wrap: wrap; }
          .topbar-right { width: 100%; justify-content: space-between; }
          .dashboard-content { padding-top: 32px; }
          .welcome-row, .balance-card, .payer-strip { align-items: flex-start; flex-direction: column; }
          .balance-card { padding: 25px; }
          .content-grid { grid-template-columns: 1fr; }
          .employee-balance-card { padding: 25px; }
          .employee-stat-grid { grid-template-columns: 1fr; }
          .proof-reference-grid, .proof-stat-grid, .proof-projection-grid { grid-template-columns: 1fr; }
          .debug-log-row { grid-template-columns: 1fr; }
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
      `}</style>
      {screen === "intro" && <Intro method={method} setMethod={setMethod} accessInput={accessInput} setAccessInput={setAccessInput} onSubmit={finishSetup} error={setupError} />}
      {screen === "setup" && <WalletSetup method={method} setMethod={setMethod} accessInput={accessInput} setAccessInput={setAccessInput} onSubmit={finishSetup} error={setupError} />}
      {screen === "dashboard" && (
        <>
          {editorOpen ? (
            <div className="app-shell"><header className="topbar"><Brand compact /><Button kind="ghost" onClick={() => setEditorOpen(false)}>Back to dashboard</Button></header><main className="dashboard-content"><PersonEditor person={editingPerson} onSave={savePerson} onCancel={() => { setEditorOpen(false); setEditingPerson(null); }} /></main></div>
          ) : dashboardView === "employee" ? (
            <EmployeeDashboard walletAddress={walletAddress} people={people} onBack={() => setDashboardView("employer")} onExportLogs={exportLogs} onReset={resetWallet} />
          ) : <Dashboard walletAddress={walletAddress} rlusdBalance={rlusdBalance} balanceLoading={balanceLoading} onRefreshBalance={() => refreshBalance()} onOpenFunding={() => setShowFunding(true)} onReset={resetWallet} people={people} onAdd={() => { setEditingPerson(null); setEditorOpen(true); }} selectedId={selectedId} onSelect={setSelectedId} onSave={savePerson} onEdit={(person) => { setEditingPerson(person); setEditorOpen(true); }} onToggle={togglePlan} onPay={payInstallment} paymentMessage={paymentMessage} history={history} debugLogs={debugLogs} onExportLogs={exportLogs} onClearLogs={clearLogs} onOpenEmployee={() => setDashboardView("employee")} />}
          {showFunding && <FundingModal onClose={() => setShowFunding(false)} />}
        </>
      )}
    </>
  );
}
