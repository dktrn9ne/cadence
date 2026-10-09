import { useId } from "react";
import { theme } from "./tokens.js";

// Gradient ribbon C per the Cadence on XRPL brand board (art_ReTIbr2H):
// two offset strokes carrying Electric Violet -> Signal Aqua, aqua at the
// upper-right tip. Sizing is owned by the `.brand-mark` CSS hooks; `size`
// overrides inline when a caller needs a fixed px mark.
export function CadenceMark({ className = "", size }) {
  const uid = useId();
  const gid = `cadence-grad-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={size ? { width: size, height: size, display: "grid", placeItems: "center", flex: "0 0 auto" } : undefined}
    >
      <svg viewBox="0 0 64 64" fill="none">
        <defs>
          <linearGradient id={gid} x1="10" y1="54" x2="54" y2="10" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={theme.accent} />
            <stop offset="1" stopColor={theme.accent2} />
          </linearGradient>
        </defs>
        <path
          d="M49 11a27 27 0 1 0 0 42"
          stroke={`url(#${gid})`}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          d="M44 17.5a19 19 0 1 0 0 29"
          stroke={`url(#${gid})`}
          strokeWidth="5.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

// Wordmark + mark lockup for topbars and the intro card. `compact` matches
// the topbar density the old Brand component used (word at 22px vs 30px).
export function CadenceLockup({ compact = false, tagline = "Real-time payroll. Income in motion." }) {
  return (
    <div className={compact ? "brand-lockup compact" : "brand-lockup"}>
      <CadenceMark className="brand-mark" />
      <div>
        <div className="brand-word">Cadence</div>
        <div className="brand-xrp">ON XRPL</div>
        {!compact && <div className="brand-tagline">{tagline}</div>}
      </div>
    </div>
  );
}
