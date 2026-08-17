import { ShieldCheck, ShieldAlert, ShieldX, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface RiskGaugeProps {
  heatPct: number; // 0-100 portfolio heat
  drawdownPct: number; // 0-100 daily drawdown vs limit
  drawdownLimitPct: number;
  breakerActive: boolean;
  reason?: string | null;
  className?: string;
}

function heatState(pct: number, breaker: boolean) {
  if (breaker) return { label: "TRIPPED", icon: ShieldOff, color: "text-destructive", bar: "bg-destructive", pulse: true };
  if (pct >= 85) return { label: "CRITICAL", icon: ShieldX, color: "text-red-400", bar: "bg-red-500", pulse: false };
  if (pct >= 60) return { label: "ELEVATED", icon: ShieldAlert, color: "text-amber-400", bar: "bg-amber-500", pulse: false };
  return { label: "SAFE", icon: ShieldCheck, color: "text-primary", bar: "bg-primary", pulse: false };
}

export function RiskGauge({
  heatPct,
  drawdownPct,
  drawdownLimitPct,
  breakerActive,
  reason,
  className,
}: RiskGaugeProps) {
  const state = heatState(heatPct, breakerActive);
  const StateIcon = state.icon;
  const heatClamped = Math.max(0, Math.min(100, heatPct));
  const ddClamped = Math.max(0, Math.min(100, (drawdownPct / Math.max(1, drawdownLimitPct)) * 100));
  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-black/30 backdrop-blur-sm p-4",
        breakerActive && "breaker-tripped border-destructive/50",
        className,
      )}
      aria-live="polite"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StateIcon className={cn("h-5 w-5", state.color, state.pulse && "animate-pulse")} />
          <h3 className="text-sm font-bold font-display uppercase tracking-wider text-muted-foreground">
            Risk Engine
          </h3>
        </div>
        <span
          className={cn(
            "text-xs font-bold font-mono uppercase px-2 py-0.5 rounded",
            state.color,
            state.pulse ? "bg-destructive/20 animate-pulse" : "bg-white/5",
          )}
          data-testid="risk-state-label"
        >
          {state.label}
        </span>
      </div>

      {/* Heat bar */}
      <div className="mb-2">
        <div className="flex justify-between text-[10px] font-mono text-muted-foreground mb-1">
          <span>PORTFOLIO HEAT</span>
          <span className={state.color}>{heatClamped.toFixed(0)}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn("h-full transition-all duration-500", state.bar)}
            style={{ width: `${heatClamped}%` }}
            data-testid="risk-heat-bar"
          />
        </div>
      </div>

      {/* Drawdown bar */}
      <div className="mb-1">
        <div className="flex justify-between text-[10px] font-mono text-muted-foreground mb-1">
          <span>DAILY DRAWDOWN</span>
          <span className={ddClamped >= 100 ? "text-destructive" : "text-muted-foreground"}>
            {drawdownPct.toFixed(1)}% / {drawdownLimitPct.toFixed(1)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full transition-all duration-500",
              ddClamped >= 100 ? "bg-destructive" : "bg-amber-500",
            )}
            style={{ width: `${ddClamped}%` }}
            data-testid="risk-drawdown-bar"
          />
        </div>
      </div>

      {breakerActive && reason && (
        <p className="text-[11px] font-mono text-destructive mt-2" data-testid="risk-breaker-reason">
          ⚠ {reason}
        </p>
      )}
    </div>
  );
}
