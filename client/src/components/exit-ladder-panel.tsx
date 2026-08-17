import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { TierBadge, type BeastTier } from "./tier-badge";

export interface LadderRung {
  multiplier: number; // e.g. 1.5, 2, 3, 5, 10, 25, 50, 100, 250, 500, 1000
  pct: number; // partial size %
  filled: boolean; // TP hit & sold
}

interface ExitLadderPanelProps {
  tokenSymbol: string;
  tier: BeastTier;
  rungs: LadderRung[];
  currentMultiplier: number; // current price multiple vs entry
  trailingPct: number | null; // trailing stop distance, null = none
  deadCatProtected: boolean;
  className?: string;
}

function fmtMult(m: number) {
  if (m >= 1000) return `${m / 1000}kx`;
  if (m >= 1) return `${m}x`;
  return `${m}x`;
}

export function ExitLadderPanel({
  tokenSymbol,
  tier,
  rungs,
  currentMultiplier,
  trailingPct,
  deadCatProtected,
  className,
}: ExitLadderPanelProps) {
  const filledCount = rungs.filter((r) => r.filled).length;
  const max = rungs.length;
  return (
    <div
      className={cn("rounded-lg border border-border/50 bg-black/30 backdrop-blur-sm p-3", className)}
      role="region"
      aria-label={`Exit ladder for ${tokenSymbol}: ${filledCount} of ${max} rungs filled, tier ${tier}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold font-display uppercase tracking-wider text-foreground">
            ${tokenSymbol}
          </span>
          <TierBadge tier={tier} size="sm" />
        </div>
        {deadCatProtected && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-mono text-violet-400"
            title="Dead-cat protection active — bag will not be exited on bounce signatures"
          >
            <Lock className="h-3 w-3" /> DEAD-CAT LOCK
          </span>
        )}
      </div>

      {/* Ladder rungs */}
      <div className="flex items-end gap-1 overflow-x-auto pb-1">
        {rungs.map((r, i) => {
          const isCurrent =
            currentMultiplier >= r.multiplier &&
            (i === rungs.length - 1 || currentMultiplier < rungs[i + 1].multiplier);
          return (
            <div key={r.multiplier} className="flex flex-col items-center min-w-[34px]">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold font-mono border",
                  r.filled
                    ? "bg-primary/30 border-primary text-primary"
                    : isCurrent
                      ? "bg-amber-500/30 border-amber-500 text-amber-400 animate-pulse"
                      : "bg-white/5 border-border/50 text-muted-foreground",
                )}
                title={`${fmtMult(r.multiplier)} — ${r.filled ? "filled" : isCurrent ? "current" : "pending"} (${r.pct}% partial)`}
              >
                {r.filled ? "✓" : isCurrent ? "◐" : "○"}
              </div>
              <span className="text-[8px] font-mono text-muted-foreground mt-0.5">{fmtMult(r.multiplier)}</span>
              <span className="text-[7px] font-mono text-muted-foreground/60">{r.pct}%</span>
            </div>
          );
        })}
      </div>

      {/* Trailing stop line */}
      {trailingPct !== null && (
        <div className="mt-2 flex items-center gap-2 text-[10px] font-mono">
          <span className="text-muted-foreground">TRAIL</span>
          <div className="flex-1 border-t border-dashed border-border/60" />
          <span className={cn("font-bold", `tier-${tier.toLowerCase()}`)}>
            @{trailingPct.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}
