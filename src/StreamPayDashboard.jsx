import { useState, useEffect, useRef } from "react";
import crossmark from "@crossmarkio/sdk";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";

// ─── Design system ──────────────────────────────────────────────────────────
const T = {
  bg:        "#F5F7F4",
  surf:      "#FFFFFF",
  surf2:     "#EDF2EF",
  surf3:     "#E1E8E4",
  border:    "rgba(22,35,31,0.11)",
  borderB:   "rgba(22,35,31,0.2)",
  green:     "#107C66",
  greenDim:  "rgba(16,124,102,0.09)",
  greenMid:  "rgba(16,124,102,0.18)",
  amber:     "#C86632",
  amberDim:  "rgba(200,102,50,0.11)",
  blue:      "#2457A6",
  blueDim:   "rgba(36,87,166,0.1)",
  purple:    "#6D55B8",
  purpleDim: "rgba(109,85,184,0.1)",
  text:      "#13201C",
  muted:     "#65746F",
  dim:       "#CBD6D1",
  mono:      "'Menlo','Monaco','Consolas',monospace",
};

// ─── Domain constants ────────────────────────────────────────────────────────
const SALARY   = 0;
const PER_SEC  = SALARY / (365 * 24 * 3600);
const PER_MIN  = PER_SEC * 60;
const CADENCE  = 300;                      // seconds between XRPL settlements
const BIWEEKLY = SALARY / 26;
const HOURS_IN = 0;
const INIT_BAL = PER_SEC * HOURS_IN * 3600;
const CADENCE_SOURCE_TAG = 2606250005;
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const DEFAULT_RLUSD_WITHDRAW_AMOUNT = "0.01";
const DEFAULT_TREASURY_ADDRESS = "rEfcBKrxNp8mxL4xu46R5wL3ex4dpDE864";
const DEFAULT_WORKER_ADDRESS = "rBKBuortXq4PYQFH768fzLZXJ1EZWhwbbi";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmt = (n, d = 2) => {
  const [whole, fraction] = n.toFixed(d).split(".");
  const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${formattedWhole}${fraction ? `.${fraction}` : ""}`;
};

const hash = () =>
  Array.from({ length: 64 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");

const shortHash = (h) => h.slice(0, 8) + "…" + h.slice(-6);

const shortAddress = (address) =>
  address ? `${address.slice(0, 6)}...${address.slice(-6)}` : "";

const getCrossmarkAddress = (result) =>
  result?.response?.data?.address ||
  result?.response?.address ||
  result?.data?.address ||
  result?.address ||
  "";

const getCrossmarkTx = (result) =>
  result?.response?.data?.resp?.result ||
  result?.response?.data?.resp ||
  result?.response?.resp?.result ||
  result?.response?.resp ||
  result?.data?.resp?.result ||
  result?.data?.resp ||
  {};

const getTxHash = (tx) =>
  tx?.hash ||
  tx?.tx_json?.hash ||
  tx?.tx?.hash ||
  tx?.transaction?.hash ||
  "";

const withCadenceSourceTag = (transaction) => ({
  ...transaction,
  SourceTag: CADENCE_SOURCE_TAG,
});

function genChart(bal) {
  return Array.from({ length: 60 }, (_, i) => {
    const secsAgo = (59 - i) * 60;
    const b = Math.max(0, bal - PER_SEC * secsAgo);
    const d = new Date(Date.now() - secsAgo * 1000);
    return { t: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), b };
  });
}

const INIT_TXS = [];

const WORKERS = [
  { id: 1, name: "Treasury", role: "Payer", salary: 0, active: true },
  { id: 2, name: "Worker", role: "Payee", salary: 0, active: true },
];

const PROOFS = [];

// ─── Primitives ───────────────────────────────────────────────────────────────
function Dot({ color, pulse }) {
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      background: color, flexShrink: 0,
      animation: pulse ? "spPulse 1.4s ease-in-out infinite" : "none",
      boxShadow: pulse ? `0 0 6px ${color}` : "none",
    }} />
  );
}

function Pill({ label, color, dim }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 20,
      background: dim || color + "11", border: `1px solid ${color}22`,
      fontSize: 10, fontWeight: 600, letterSpacing: "0.07em",
      textTransform: "uppercase", color,
    }}>
      <Dot color={color} pulse />
      {label}
    </span>
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: T.surf, border: `1px solid ${T.border}`,
      borderRadius: 8, boxShadow: "0 12px 34px rgba(34,49,43,0.06)", ...style,
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
      textTransform: "uppercase", color: T.muted, marginBottom: 12,
    }}>
      {children}
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: color || T.text }}>{value}</div>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: T.surf3, border: `1px solid ${T.border}`,
      borderRadius: 8, padding: "8px 12px",
    }}>
      <div style={{ fontSize: 10, color: T.muted, marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: T.mono, fontSize: 13, color: T.green }}>{fmt(payload[0].value, 4)}</div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar({ tab, setTab }) {
  const nav = [
    { id: "worker",   label: "Worker"        },
    { id: "employer", label: "Treasury"      },
    { id: "nullmark", label: "Proofs"        },
  ];

  const protocols = [
    { label: "Crossmark",     sub: "Browser-native signing",    color: T.green  },
    { label: "XRPL",          sub: "Fast payroll settlement",    color: T.blue   },
    { label: "SecretVM",      sub: "Salary data sealed",        color: T.purple },
    { label: "Proofs",        sub: "Portable income proofs",    color: T.amber  },
  ];

  return (
    <div style={{
      width: 200, flexShrink: 0, background: T.surf,
      borderRight: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column",
      padding: "20px 0", minHeight: "100%",
    }}>
      {/* Logo */}
      <div style={{ padding: "0 18px 24px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, background: T.text, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.surf,
          }}>CD</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, letterSpacing: 0 }}>Cadence</div>
            <div style={{ fontSize: 10, color: T.muted }}>Payroll to trust</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ padding: "16px 10px 20px", borderBottom: `1px solid ${T.border}` }}>
        {nav.map(item => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
              marginBottom: 2, fontSize: 13, fontWeight: tab === item.id ? 600 : 400,
              background: tab === item.id ? T.greenDim : "transparent",
              color: tab === item.id ? T.green : T.muted,
              transition: "all 0.15s",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Protocol status */}
      <div style={{ padding: "16px 18px", flex: 1 }}>
        <SectionLabel>Settlement stack</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {protocols.map(p => (
            <div key={p.label} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ paddingTop: 4 }}><Dot color={p.color} pulse /></div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: p.color }}>{p.label}</div>
                <div style={{ fontSize: 10, color: T.muted, marginTop: 1 }}>{p.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: "16px 18px", borderTop: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.5 }}>
          Toledo Holdings<br />
          <span style={{ color: T.muted, fontSize: 9 }}>Crossmark · XRPL · Proofs</span>
        </div>
      </div>
    </div>
  );
}

// ─── Worker view ──────────────────────────────────────────────────────────────
function WorkerView({ balance, tick, onWithdraw }) {
  const [chartData, setChartData] = useState(() => genChart(INIT_BAL));
  const [txs] = useState(INIT_TXS);
  const [withdrawn] = useState(0);
  const [wCount] = useState(0);

  useEffect(() => {
    if (tick > 0 && tick % 60 === 0) {
      const d = new Date();
      setChartData(prev => [
        ...prev.slice(1),
        { t: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), b: balance },
      ]);
    }
  }, [tick]);

  const earnedToday = PER_SEC * (HOURS_IN * 3600 + tick);
  const periodEarned = 0;
  const pct = BIWEEKLY > 0 ? Math.min(100, (periodEarned / BIWEEKLY) * 100) : 0;
  const nextTx = CADENCE - (tick % CADENCE);
  const mm = String(Math.floor(nextTx / 60)).padStart(2, "0");
  const ss = String(nextTx % 60).padStart(2, "0");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Hero balance */}
      <Card style={{ padding: "24px 28px", position: "relative", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 10 }}>
              Available earnings · RLUSD
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 54, fontWeight: 700, color: T.green, lineHeight: 1, letterSpacing: 0, marginBottom: 10 }}>
              {fmt(balance, 4)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>
                +{fmt(PER_MIN, 5)}<span style={{ color: T.muted + "77" }}>/min</span>
              </span>
              <span style={{ color: T.dim }}>·</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>
                +{fmt(PER_SEC, 7)}<span style={{ color: T.muted + "77" }}>/sec</span>
              </span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Pill label="Earning live" color={T.green} />
              <Pill label="TEE sealed" color={T.purple} />
            </div>
            <button
              onClick={onWithdraw}
              style={{
                background: T.text, color: T.surf, border: "none",
                borderRadius: 8, padding: "11px 24px", fontWeight: 700,
                fontSize: 13, cursor: "pointer", letterSpacing: "0.02em",
                transition: "opacity 0.15s",
              }}
            >
              Withdraw now
            </button>
          </div>
        </div>

        {/* Period progress */}
        <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.muted, marginBottom: 6 }}>
            <span>Pay period progress</span>
            <span style={{ color: T.green }}>{pct.toFixed(1)}% · {fmt(periodEarned)} of {fmt(BIWEEKLY)}</span>
          </div>
          <div style={{ height: 4, background: T.dim, borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: `linear-gradient(90deg, ${T.green}, ${T.blue})`,
              borderRadius: 2, transition: "width 1.2s ease",
            }} />
          </div>
        </div>
      </Card>

      {/* Stat row */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          { label: "Earned today",  value: fmt(earnedToday),  color: T.green,  sub: `${(HOURS_IN + tick / 3600).toFixed(1)}h worked` },
          { label: "This period",   value: fmt(periodEarned), color: T.blue,   sub: "14-day cycle" },
          { label: "Rate / min",    value: fmt(PER_MIN, 5),   color: T.muted,  sub: "accrual rate" },
          { label: "Withdrawn",     value: fmt(withdrawn),    color: T.text,   sub: `${wCount} pulls today` },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, minWidth: 120,
            background: T.surf, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "14px 16px",
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: s.color, marginBottom: 3 }}>{s.value}</div>
            <div style={{ fontSize: 10, color: T.muted }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Chart + TX feed */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 12 }}>
        <Card style={{ padding: "18px 18px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <SectionLabel>60-min stream chart</SectionLabel>
            <div style={{ display: "flex", gap: 4 }}>
              {["1H", "8H", "1D"].map((l, i) => (
                <span key={l} style={{
                  fontSize: 10, padding: "3px 7px", borderRadius: 5, cursor: "pointer",
                  background: i === 0 ? T.greenDim : "transparent",
                  color: i === 0 ? T.green : T.muted,
                  border: i === 0 ? `1px solid ${T.border}` : "1px solid transparent",
                }}>{l}</span>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <AreaChart data={chartData} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={T.green} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={T.green} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} interval={14} />
              <YAxis tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v, 0)} width={46} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="b" stroke={T.green} strokeWidth={1.8} fill="url(#bg)" dot={false} activeDot={{ r: 3, fill: T.green }} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* TX feed */}
        <Card style={{ padding: "18px", display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionLabel>Settlement receipts</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
            {txs.length === 0 && (
              <div style={{
                padding: "18px 12px", borderRadius: 8, background: T.surf2,
                color: T.muted, fontSize: 11, textAlign: "center",
              }}>
                No settlements yet
              </div>
            )}
            {txs.slice(0, 5).map((tx, i) => (
              <div key={i} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "7px 9px", borderRadius: 8,
                background: tx.fresh ? T.greenMid : T.surf2,
                border: `1px solid ${tx.fresh ? T.border : "transparent"}`,
                transition: "background 0.4s ease, border 0.4s ease",
              }}>
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginBottom: 2 }}>{shortHash(tx.h)}</div>
                  <div style={{ fontSize: 9, color: T.muted }}>{tx.label}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 12, color: T.green, fontWeight: 700 }}>+{fmt(tx.amt, 4)}</div>
                  <div style={{ fontSize: 9, color: T.green + "88" }}>settled</div>
                </div>
              </div>
            ))}
          </div>
          {/* Countdown */}
          <div style={{ padding: "8px 10px", borderRadius: 8, background: T.surf2, textAlign: "center", marginTop: 2 }}>
            <span style={{ fontSize: 10, color: T.muted }}>Next settlement </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.green }}>{mm}:{ss}</span>
          </div>
        </Card>
      </div>

      {/* x402 spending */}
      <Card style={{ padding: "18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <SectionLabel>Pay rails</SectionLabel>
          <Pill label="HTTP-native" color={T.blue} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          <div style={{
            gridColumn: "1 / -1", background: T.surf2, borderRadius: 8,
            padding: "12px 14px", color: T.muted, fontSize: 11, textAlign: "center",
          }}>
            No pay rails configured
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Employer view ────────────────────────────────────────────────────────────
function EmployerView() {
  const [workers, setWorkers] = useState(WORKERS);
  const poolBalance = 0;
  const dailyBurn = workers.filter(w => w.active).reduce((s, w) => s + w.salary / 365, 0);
  const runway = dailyBurn > 0 ? poolBalance / dailyBurn : 0;

  const toggle = (id) => setWorkers(prev => prev.map(w => w.id === id ? { ...w, active: !w.active } : w));

  const barData = workers.map(w => ({
    name: w.name.split(" ")[0],
    rate: parseFloat(((w.salary / (365 * 24 * 60)) * 5).toFixed(4)),
    active: w.active,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Pool hero */}
      <Card style={{ padding: "24px 28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 10 }}>
              Payroll pool balance · RLUSD
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 52, fontWeight: 700, color: T.text, lineHeight: 1, marginBottom: 8 }}>
              {fmt(poolBalance)}
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.amber }}>
                −{fmt(dailyBurn, 2)}<span style={{ color: T.muted + "77" }}>/day</span>
              </span>
              <span style={{ color: T.dim }}>·</span>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: runway < 7 ? T.amber : T.green }}>
                {runway.toFixed(1)}d runway
              </span>
            </div>
          </div>
          <button style={{
            background: T.text, color: T.surf, border: "none", borderRadius: 8,
            padding: "11px 24px", fontWeight: 700, fontSize: 13, cursor: "pointer",
          }}>
            Top up pool
          </button>
        </div>
      </Card>

      {/* Stats */}
      <div style={{ display: "flex", gap: 12 }}>
        {[
          { label: "Active workers",     value: workers.filter(w => w.active).length + ` of ${workers.length}`, color: T.green },
          { label: "Daily burn",         value: fmt(dailyBurn),                                                  color: T.amber },
          { label: "Settled this period",value: fmt(dailyBurn * 7),                                              color: T.blue  },
          { label: "Avg salary",         value: fmt(workers.length ? workers.reduce((s,w) => s+w.salary,0)/workers.length : 0, 0), color: T.text  },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, minWidth: 100, background: T.surf, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "14px 16px",
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 8 }}>{s.label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Workforce table + chart */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 12 }}>
        <Card style={{ padding: "18px", overflow: "hidden" }}>
          <SectionLabel>Active workforce</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {workers.map(w => (
              <div key={w.id} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px", borderRadius: 8, background: T.surf2,
                border: `1px solid ${w.active ? T.border : "transparent"}`,
                opacity: w.active ? 1 : 0.5,
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                  background: w.active ? T.greenDim : T.dim,
                  border: `1px solid ${w.active ? T.border : "transparent"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                  color: w.active ? T.green : T.muted,
                }}>
                  {w.name.split(" ").map(n => n[0]).join("")}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{w.name}</div>
                  <div style={{ fontSize: 10, color: T.muted }}>{w.role}</div>
                </div>
                <div style={{ textAlign: "right", marginRight: 8 }}>
                  <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{fmt(w.salary, 0)}/yr</div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.green }}>
                    +{fmt((w.salary / (365 * 24 * 3600)) * 60, 5)}/min
                  </div>
                </div>
                <button
                  onClick={() => toggle(w.id)}
                  style={{
                    padding: "5px 12px", borderRadius: 6, fontSize: 11,
                    fontWeight: 600, cursor: "pointer", border: "none",
                    background: w.active ? T.greenDim : T.dim,
                    color: w.active ? T.green : T.muted,
                  }}
                >
                  {w.active ? "Streaming" : "Paused"}
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ padding: "18px" }}>
          <SectionLabel>Burn rate / 5 min</SectionLabel>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={barData} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
              <Tooltip
                formatter={(v) => [`$${v}`, "RLUSD / 5 min"]}
                contentStyle={{ background: T.surf3, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: T.muted }}
                itemStyle={{ color: T.green }}
              />
              <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                {barData.map((d, i) => (
                  <Cell key={i} fill={d.active ? T.green : T.dim} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: T.surf2 }}>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 3 }}>SecretVM status</div>
            <Pill label="Salary data sealed" color={T.purple} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── Proofs view ──────────────────────────────────────────────────────────────
function ProofsView() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Credit status hero */}
      <Card style={{ padding: "24px 28px", borderColor: "rgba(139,125,216,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted, marginBottom: 10 }}>
              Cadence Proofs
            </div>
            <div style={{ fontSize: 36, fontWeight: 700, color: T.text, lineHeight: 1, marginBottom: 8 }}>
              On-chain income profile
            </div>
            <div style={{ fontSize: 13, color: T.muted, maxWidth: 480, lineHeight: 1.6 }}>
              Verified ZK income proofs — posted to zkVerify without revealing salary figures. Lenders confirm your income threshold without you disclosing a number.
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
            <Pill label="0 proofs verified" color={T.green} />
            <Pill label="0 pending" color={T.amber} />
          </div>
        </div>
      </Card>

      {/* Impact + proof list */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

        <Card style={{ padding: "18px" }}>
          <SectionLabel>ZK proof history</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {PROOFS.length === 0 && (
              <div style={{
                padding: "18px 12px", borderRadius: 8, background: T.surf2,
                color: T.muted, fontSize: 11, textAlign: "center",
              }}>
                No proofs posted yet
              </div>
            )}
            {PROOFS.map((p, i) => (
              <div key={i} style={{
                padding: "10px 12px", borderRadius: 8, background: T.surf2,
                border: `1px solid ${p.ok ? T.border : "transparent"}`,
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: p.ok ? T.text : T.muted, marginBottom: 3 }}>{p.level}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
                    {p.hash ? shortHash(p.hash) : "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 10, color: p.ok ? T.green : T.amber, fontWeight: 600 }}>
                    {p.ok ? "verified" : "pending"}
                  </div>
                  <div style={{ fontSize: 9, color: T.muted }}>{p.date}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Credit impact */}
          <Card style={{ padding: "18px", flex: 1 }}>
            <SectionLabel>Credit impact</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Loan approval likelihood", delta: "0%", color: T.muted },
                { label: "Rental application strength", delta: "0%", color: T.muted },
                { label: "Income verification time", delta: "0%", color: T.muted },
              ].map(item => (
                <div key={item.label} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "8px 12px", borderRadius: 8, background: T.surf2,
                }}>
                  <div style={{ fontSize: 12, color: T.muted }}>{item.label}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: item.color }}>{item.delta}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* How it works */}
          <Card style={{ padding: "18px" }}>
            <SectionLabel>How it works</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { step: "1", text: "XRPL settlement history accumulates on-chain" },
                { step: "2", text: "SecretVM computes income threshold inside TEE" },
                { step: "3", text: "ZK proof posted to zkVerify — no salary disclosed" },
                { step: "4", text: "Lender verifies proof without seeing your number" },
              ].map(item => (
                <div key={item.step} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", background: T.purpleDim,
                    border: `1px solid ${T.purple}33`, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 9, fontWeight: 700, color: T.purple, flexShrink: 0, marginTop: 1,
                  }}>{item.step}</div>
                  <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{item.text}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Attestation panel */}
      <Card style={{ padding: "18px", borderColor: "rgba(139,125,216,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <SectionLabel>Latest attestation · zkVerify</SectionLabel>
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.muted }}>No attestation yet</div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>Submit a mainnet settlement before posting proof data.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Pill label="TEE pending" color={T.purple} />
            <Pill label="On-chain pending" color={T.green} />
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Withdraw panel ───────────────────────────────────────────────────────────
function WithdrawPanel({ balance, onClose, onConfirm }) {
  return (
    <div style={{
      background: T.surf2, border: `1px solid ${T.borderB}`,
      borderRadius: 8, padding: "20px 24px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>Withdraw RLUSD</div>
          <div style={{ fontSize: 12, color: T.muted }}>
            Instant transfer · RLUSD → USD via exchange offramp
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: T.muted, marginBottom: 3 }}>Available</div>
            <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: T.green }}>{fmt(balance, 4)}</div>
          </div>
          <button onClick={onConfirm} style={{
            background: T.text, color: T.surf, border: "none",
            borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer",
          }}>Confirm</button>
          <button onClick={onClose} style={{
            background: T.surf, color: T.muted, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "10px 14px", fontSize: 13, cursor: "pointer",
          }}>✕</button>
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────
function SettlementPanel({
  balance,
  onClose,
  onConfirm,
  workerAddress,
  setWorkerAddress,
  rlusdAmount,
  setRlusdAmount,
  settlementStatus,
  wallet,
}) {
  const busy = settlementStatus.state === "submitting";
  const txHash = getTxHash(wallet.lastTx);

  return (
    <div style={{
      background: T.surf2, border: `1px solid ${T.borderB}`,
      borderRadius: 8, padding: "20px 24px", marginBottom: 14,
    }}>
      <form onSubmit={onConfirm} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 4 }}>Settle RLUSD</div>
            <div style={{ fontSize: 12, color: T.muted }}>
              Crossmark signs an XRPL mainnet payment from treasury to worker.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 3 }}>Available</div>
              <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: T.green }}>{fmt(balance, 4)}</div>
            </div>
            <button type="submit" disabled={busy} style={{
              background: T.text, color: T.surf, border: "none",
              borderRadius: 8, padding: "10px 20px", fontSize: 13,
              fontWeight: 700, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1,
            }}>
              {busy ? "Submitting" : "Submit"}
            </button>
            <button type="button" onClick={onClose} style={{
              background: T.surf, color: T.muted, border: `1px solid ${T.border}`,
              borderRadius: 8, padding: "10px 14px", fontSize: 13, cursor: "pointer",
            }}>Close</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) 160px", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted }}>
              Worker address
            </span>
            <input
              value={workerAddress}
              onChange={(event) => setWorkerAddress(event.target.value.trim())}
              placeholder="r..."
              style={{
                width: "100%", border: `1px solid ${T.border}`, background: T.surf,
                color: T.text, borderRadius: 8, padding: "10px 12px",
                fontFamily: T.mono, fontSize: 12, outline: "none",
              }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: T.muted }}>
              RLUSD
            </span>
            <input
              value={rlusdAmount}
              onChange={(event) => setRlusdAmount(event.target.value)}
              inputMode="decimal"
              style={{
                width: "100%", border: `1px solid ${T.border}`, background: T.surf,
                color: T.text, borderRadius: 8, padding: "10px 12px",
                fontFamily: T.mono, fontSize: 12, outline: "none",
              }}
            />
          </label>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Pill label={`SourceTag ${CADENCE_SOURCE_TAG}`} color={T.blue} />
          <Pill label="RLUSD" color={T.green} />
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
            Treasury {shortAddress(DEFAULT_TREASURY_ADDRESS)}
          </span>
        </div>

        {(settlementStatus.message || wallet.error || txHash) && (
          <div style={{
            padding: "10px 12px", borderRadius: 8, background: T.surf,
            border: `1px solid ${settlementStatus.state === "error" || wallet.error ? T.amberDim : T.border}`,
            color: settlementStatus.state === "error" || wallet.error ? T.amber : T.muted,
            fontSize: 12,
          }}>
            {settlementStatus.message || wallet.error}
            {txHash && (
              <a
                href={`https://xrpscan.com/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: T.green, marginLeft: 8, fontFamily: T.mono }}
              >
                {shortHash(txHash)}
              </a>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

function WalletStatus({ wallet, onConnect }) {
  const connected = Boolean(wallet.address);
  const busy = wallet.status === "connecting";

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "6px 8px 6px 10px", border: `1px solid ${connected ? T.greenMid : T.border}`,
      borderRadius: 8, background: connected ? T.greenDim : T.surf2,
      minHeight: 34,
    }}>
      <Dot color={connected ? T.green : T.amber} pulse={connected || busy} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1 }}>Crossmark</div>
        <div style={{
          fontFamily: T.mono, fontSize: 11, color: connected ? T.green : T.text,
          maxWidth: 132, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {connected ? shortAddress(wallet.address) : wallet.status}
        </div>
      </div>
      <button
        onClick={onConnect}
        disabled={busy}
        style={{
          border: "none", borderRadius: 7, padding: "6px 10px",
          background: connected ? T.surf3 : T.green, color: connected ? T.text : T.bg,
          fontSize: 11, fontWeight: 700, cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Connecting" : connected ? "Switch" : "Connect"}
      </button>
    </div>
  );
}

export default function CadenceDashboard() {
  const [tick, setTick]             = useState(0);
  const [balance, setBalance]       = useState(INIT_BAL);
  const [tab, setTab]               = useState("worker");
  const [showWithdraw, setShow]     = useState(false);
  const [workerAddress, setWorkerAddress] = useState(DEFAULT_WORKER_ADDRESS);
  const [rlusdAmount, setRlusdAmount] = useState(DEFAULT_RLUSD_WITHDRAW_AMOUNT);
  const [settlementStatus, setSettlementStatus] = useState({ state: "idle", message: "" });
  const [wallet, setWallet]         = useState({
    status: "not connected",
    address: "",
    error: "",
    lastTx: null,
  });

  useEffect(() => {
    const id = setInterval(() => {
      setTick(t => t + 1);
      setBalance(b => b + PER_SEC);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const handleWithdrawConfirm = async (event) => {
    event.preventDefault();

    const amount = Number(rlusdAmount);
    if (!workerAddress || !workerAddress.startsWith("r")) {
      setSettlementStatus({ state: "error", message: "Enter a valid XRPL worker address." });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setSettlementStatus({ state: "error", message: "Enter an RLUSD amount greater than zero." });
      return;
    }

    setSettlementStatus({ state: "submitting", message: "Confirm the RLUSD payment in Crossmark." });

    try {
      const tx = await submitCrossmarkPayment({
        destination: workerAddress,
        amountValue: rlusdAmount,
      });

      if (!tx) {
        setSettlementStatus({ state: "error", message: "Crossmark did not return a submitted transaction." });
        return;
      }

      setBalance(0);
      setSettlementStatus({ state: "success", message: "RLUSD settlement submitted with the Cadence source tag." });
    } catch (error) {
      setSettlementStatus({
        state: "error",
        message: error?.message || "Crossmark payment failed.",
      });
    }
  };

  const connectCrossmark = async () => {
    setWallet((prev) => ({ ...prev, status: "connecting", error: "" }));

    try {
      const result = await crossmark.methods.signInAndWait();
      const address = getCrossmarkAddress(result);

      if (!address) {
        throw new Error("Crossmark did not return an active XRPL address.");
      }

      setWallet({
        status: "connected",
        address,
        error: "",
        lastTx: null,
      });
      return address;
    } catch (error) {
      setWallet((prev) => ({
        ...prev,
        status: "connect failed",
        error: error?.message || "Crossmark connection was cancelled.",
      }));
      return "";
    }
  };

  const submitCrossmarkPayment = async ({ destination, amountValue }) => {
    const account = wallet.address || DEFAULT_TREASURY_ADDRESS;

    if (wallet.address && account !== DEFAULT_TREASURY_ADDRESS) {
      throw new Error(`Connect the treasury wallet ${shortAddress(DEFAULT_TREASURY_ADDRESS)} before submitting.`);
    }

    const result = await crossmark.methods.signAndSubmitAndWait(withCadenceSourceTag({
      TransactionType: "Payment",
      Account: account,
      Destination: destination,
      Amount: {
        currency: RLUSD_CURRENCY,
        issuer: RLUSD_ISSUER,
        value: amountValue,
      },
    }));
    const tx = getCrossmarkTx(result);

    setWallet((prev) => ({ ...prev, lastTx: tx }));

    return tx;
  };

  return (
    <>
      <style>{`
        @keyframes spPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:.4; transform:scale(.75); }
        }
        * { box-sizing: border-box; }
        button { font-family: inherit; }
      `}</style>
      <div style={{
        display: "flex", minHeight: "100vh",
        background: T.bg, color: T.text, fontFamily: "system-ui,sans-serif",
      }}>
        <Sidebar tab={tab} setTab={setTab} />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Top bar */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}`,
            background: T.surf, flexShrink: 0, flexWrap: "wrap", gap: 10,
          }}>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { id: "worker",   label: "Worker" },
                { id: "employer", label: "Treasury" },
                { id: "nullmark", label: "Proofs" },
              ].map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: tab === t.id ? 700 : 400,
                  background: tab === t.id ? T.greenDim : "transparent",
                  color: tab === t.id ? T.green : T.muted,
                  transition: "all 0.15s",
                }}>{t.label}</button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Pill label="Crossmark ready" color={T.green} />
              <WalletStatus wallet={wallet} onConnect={connectCrossmark} />
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>
                {new Date().toLocaleTimeString()}
              </div>
            </div>
          </div>

          {/* Main scroll area */}
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            {showWithdraw && (
              <SettlementPanel
                balance={balance}
                onClose={() => setShow(false)}
                onConfirm={handleWithdrawConfirm}
                workerAddress={workerAddress}
                setWorkerAddress={setWorkerAddress}
                rlusdAmount={rlusdAmount}
                setRlusdAmount={setRlusdAmount}
                settlementStatus={settlementStatus}
                wallet={wallet}
              />
            )}
            {tab === "worker"   && <WorkerView   balance={balance} tick={tick} onWithdraw={() => setShow(true)} />}
            {tab === "employer" && <EmployerView />}
            {tab === "nullmark" && <ProofsView />}
          </div>
        </div>
      </div>
    </>
  );
}
