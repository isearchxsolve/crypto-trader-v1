import { Snowflake, Flame, FlameKindling, Rocket, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

export type BeastTier = "COLD" | "WARM" | "HOT" | "ROCKET" | "MOONSHOT";

interface TierBadgeProps {
  tier: BeastTier;
  size?: "sm" | "md";
  className?: string;
}

const tierConfig: Record<BeastTier, {
  icon: React.ElementType;
  textClass: string;
  glowClass: string;
  bgClass: string;
  pulse: boolean;
}> = {
  COLD: { icon: Snowflake, textClass: "tier-cold", glowClass: "tier-glow-cold", bgClass: "bg-slate-500/20", pulse: false },
  WARM: { icon: FlameKindling, textClass: "tier-warm", glowClass: "tier-glow-warm", bgClass: "bg-amber-500/20", pulse: false },
  HOT: { icon: Flame, textClass: "tier-hot", glowClass: "tier-glow-hot", bgClass: "bg-red-500/20", pulse: false },
  ROCKET: { icon: Rocket, textClass: "tier-rocket", glowClass: "tier-glow-rocket", bgClass: "bg-violet-500/20", pulse: false },
  MOONSHOT: { icon: Moon, textClass: "tier-moonshot", glowClass: "tier-glow-moonshot", bgClass: "bg-primary/20", pulse: true },
};

export function TierBadge({ tier, size = "md", className }: TierBadgeProps) {
  const cfg = tierConfig[tier];
  const Icon = cfg.icon;
  const sizeClass = size === "sm" ? "text-[9px] h-5 px-1.5" : "text-[10px] h-6 px-2";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <span
      role="status"
      aria-label={`Tier ${tier}`}
      className={cn(
        "inline-flex items-center gap-1 rounded border-0 font-bold font-display uppercase tracking-wider",
        sizeClass,
        cfg.textClass,
        cfg.glowClass,
        cfg.bgClass,
        cfg.pulse && "animate-pulse",
        className,
      )}
    >
      <Icon className={iconSize} />
      {tier}
    </span>
  );
}
