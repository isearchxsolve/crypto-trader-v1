import { Check, X, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type SurfaceStatus = "PASS" | "VETO" | "PENDING";

export interface SafetySurface {
  name: string;
  status: SurfaceStatus;
  reason?: string;
}

interface SafetyChipsProps {
  surfaces: SafetySurface[];
  size?: "sm" | "md";
  className?: string;
}

const statusConfig: Record<SurfaceStatus, { icon: React.ElementType; textClass: string; bgClass: string }> = {
  PASS: { icon: Check, textClass: "text-primary", bgClass: "bg-primary/15" },
  VETO: { icon: X, textClass: "text-destructive", bgClass: "bg-destructive/15" },
  PENDING: { icon: Pause, textClass: "text-muted-foreground", bgClass: "bg-white/5" },
};

export function SafetyChips({ surfaces, size = "sm", className }: SafetyChipsProps) {
  const hasVeto = surfaces.some((s) => s.status === "VETO");
  const chipSize = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <div
      role="status"
      aria-label={`Safety surfaces: ${surfaces.filter((s) => s.status === "PASS").length}/${surfaces.length} passed`}
      className={cn(
        "flex flex-wrap items-center gap-1 rounded p-1",
        hasVeto && "border border-destructive/50 animate-pulse rounded",
        className,
      )}
    >
      {surfaces.map((s) => {
        const cfg = statusConfig[s.status];
        const Icon = cfg.icon;
        return (
          <Tooltip key={s.name}>
            <TooltipTrigger asChild>
              <span
                aria-label={`${s.name}: ${s.status}`}
                className={cn(
                  "inline-flex items-center justify-center rounded font-mono",
                  chipSize,
                  cfg.textClass,
                  cfg.bgClass,
                )}
              >
                <Icon className={iconSize} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px]">
              <div className="text-xs font-bold uppercase">{s.name}: {s.status}</div>
              {s.reason && <div className="text-[10px] text-muted-foreground mt-0.5">{s.reason}</div>}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
