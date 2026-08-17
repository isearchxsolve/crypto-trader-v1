import { CheckCircle2, XCircle, LogOut, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TierBadge, type BeastTier } from "./tier-badge";

export type DecisionType = "ADMIT" | "VETO" | "EXIT" | "PROMOTE";

export interface DecisionEntry {
  id: string | number;
  timestamp: string;
  type: DecisionType;
  tokenSymbol: string;
  tier?: BeastTier;
  reason: string;
  score?: number | null;
}

interface ObservabilityFeedProps {
  entries: DecisionEntry[];
  filter?: DecisionType | "ALL";
  onFilterChange?: (f: DecisionType | "ALL") => void;
  className?: string;
}

const typeConfig: Record<DecisionType, { icon: React.ElementType; color: string }> = {
  ADMIT: { icon: CheckCircle2, color: "text-primary" },
  VETO: { icon: XCircle, color: "text-destructive" },
  EXIT: { icon: LogOut, color: "text-amber-400" },
  PROMOTE: { icon: TrendingUp, color: "text-violet-400" },
};

const filters: (DecisionType | "ALL")[] = ["ALL", "ADMIT", "VETO", "EXIT", "PROMOTE"];

export function ObservabilityFeed({
  entries,
  filter = "ALL",
  onFilterChange,
  className,
}: ObservabilityFeedProps) {
  const visible = filter === "ALL" ? entries : entries.filter((e) => e.type === filter);
  return (
    <div className={cn("flex flex-col h-full rounded-lg border border-border/50 bg-black/30 backdrop-blur-sm", className)}>
      <div className="flex items-center justify-between p-3 border-b border-border/30">
        <h3 className="text-sm font-bold font-display uppercase tracking-wider text-muted-foreground">
          Observability Feed
        </h3>
        {onFilterChange && (
          <div className="flex gap-1">
            {filters.map((f) => (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                className={cn(
                  "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded transition-colors",
                  filter === f ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
      <ScrollArea className="flex-1 p-2" data-testid="observability-feed-scroll">
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">
            No decisions logged
          </div>
        ) : (
          <div className="space-y-0.5">
            {visible.map((e) => {
              const cfg = typeConfig[e.type];
              const Icon = cfg.icon;
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/5 transition-colors text-xs font-mono"
                  data-testid={`obs-row-${e.id}`}
                >
                  <Icon className={cn("h-3.5 w-3.5 flex-shrink-0", cfg.color)} />
                  <span className="text-muted-foreground/60 text-[10px] w-16">
                    {new Date(e.timestamp).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span className={cn("font-bold w-12", cfg.color)}>{e.type}</span>
                  <span className="text-primary font-bold">
                    ${e.tokenSymbol}
                  </span>
                  {e.tier && <TierBadge tier={e.tier} size="sm" />}
                  {e.score != null && (
                    <span className="text-muted-foreground text-[10px]">[{e.score.toFixed(0)}]</span>
                  )}
                  <span className="text-muted-foreground/80 truncate flex-1" title={e.reason}>
                    {e.reason}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
