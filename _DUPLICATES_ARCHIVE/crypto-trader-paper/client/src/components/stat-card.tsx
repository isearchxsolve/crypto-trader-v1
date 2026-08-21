import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface StatCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  icon?: React.ElementType;
  trend?: "up" | "down" | "neutral";
  color?: "primary" | "secondary" | "destructive" | "default";
  className?: string;
  animate?: boolean;
}

export function StatCard({ 
  label, 
  value, 
  subValue, 
  icon: Icon, 
  trend,
  color = "default",
  className,
  animate = false
}: StatCardProps) {
  
  const colorMap = {
    primary: "text-primary border-primary/30 shadow-[0_0_20px_-5px_rgba(38,217,98,0.2)]",
    secondary: "text-secondary border-secondary/30 shadow-[0_0_20px_-5px_rgba(142,68,173,0.2)]",
    destructive: "text-destructive border-destructive/30 shadow-[0_0_20px_-5px_rgba(239,68,68,0.2)]",
    default: "text-foreground border-border"
  };

  const bgMap = {
    primary: "bg-primary/5",
    secondary: "bg-secondary/5",
    destructive: "bg-destructive/5",
    default: "bg-card/50"
  };

  return (
    <motion.div 
      initial={animate ? { opacity: 0, y: 20 } : undefined}
      animate={animate ? { opacity: 1, y: 0 } : undefined}
      className={cn(
        "rounded-lg p-5 border backdrop-blur-md transition-all duration-300 hover:bg-white/5",
        colorMap[color],
        bgMap[color],
        className
      )}
    >
      <div className="flex justify-between items-start mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</h3>
        {Icon && <Icon className={cn("h-5 w-5 opacity-80", color === 'default' ? 'text-primary' : '')} />}
      </div>
      
      <div className="flex items-baseline gap-2">
        <span className={cn(
          "text-2xl font-mono font-bold tracking-tight",
          color === 'default' ? 'text-foreground' : ''
        )}>
          {value}
        </span>
        {subValue && (
          <span className="text-xs text-muted-foreground font-mono">
            {subValue}
          </span>
        )}
      </div>

      {trend && (
        <div className="mt-2 h-1 w-full bg-black/20 rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: "60%" }}
            transition={{ duration: 1, delay: 0.5 }}
            className={cn(
              "h-full rounded-full",
              trend === "up" ? "bg-primary" : trend === "down" ? "bg-destructive" : "bg-muted"
            )} 
          />
        </div>
      )}
    </motion.div>
  );
}
