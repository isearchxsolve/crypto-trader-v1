import { Crosshair, Activity, Bomb } from "lucide-react";
import { cn } from "@/lib/utils";

export type EntryMode = "SNIPER" | "EDGE" | "EXPLOSIVE";

interface ModeBadgeProps {
  mode: EntryMode;
  size?: "sm" | "md";
  className?: string;
}

const modeConfig: Record<EntryMode, { icon: React.ElementType; textClass: string; bgClass: string }> = {
  SNIPER: { icon: Crosshair, textClass: "mode-sniper", bgClass: "bg-purple-500/20" },
  EDGE: { icon: Activity, textClass: "mode-edge", bgClass: "bg-blue-500/20" },
  EXPLOSIVE: { icon: Bomb, textClass: "mode-explosive", bgClass: "bg-orange-500/20" },
};

export function ModeBadge({ mode, size = "md", className }: ModeBadgeProps) {
  const cfg = modeConfig[mode];
  const Icon = cfg.icon;
  const sizeClass = size === "sm" ? "text-[9px] h-5 px-1.5" : "text-[10px] h-6 px-2";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <span
      role="status"
      aria-label={`Entry mode ${mode}`}
      className={cn(
        "inline-flex items-center gap-1 rounded border-0 font-bold font-display uppercase tracking-wider",
        sizeClass,
        cfg.textClass,
        cfg.bgClass,
        className,
      )}
    >
      <Icon className={iconSize} />
      {mode}
    </span>
  );
}
