import { Link, useLocation } from "wouter";
import { LayoutDashboard, Settings, ScrollText, Activity, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", icon: LayoutDashboard, label: "Dashboard" },
    { href: "/logs", icon: ScrollText, label: "System Logs" },
    { href: "/settings", icon: Settings, label: "Settings" },
  ];

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border/40 bg-card/30 flex flex-col backdrop-blur-sm z-20">
        <div className="p-6 border-b border-border/40 flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20 shadow-[0_0_15px_-3px_rgba(38,217,98,0.3)]">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-widest text-foreground">SOL-SNIPER</h1>
            <p className="text-xs text-primary font-mono tracking-wider">V.9.0.1 [BETA]</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-md text-sm font-medium transition-all duration-200 group relative overflow-hidden",
                isActive 
                  ? "text-primary bg-primary/10 border border-primary/20 shadow-[inset_0_0_10px_rgba(38,217,98,0.1)]" 
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}>
                {isActive && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-primary shadow-[0_0_10px_rgba(38,217,98,0.8)]" />
                )}
                <item.icon className={cn("h-5 w-5", isActive && "text-primary animate-pulse")} />
                <span className="font-display uppercase tracking-wide">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border/40">
          <div className="bg-black/40 rounded p-3 border border-border/50">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="h-4 w-4 text-primary" />
              <span className="text-xs font-bold text-muted-foreground uppercase">Network Status</span>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="text-foreground">Solana Mainnet</span>
              <span className="text-primary flex items-center gap-1">
                <span className="block h-1.5 w-1.5 rounded-full bg-primary animate-ping" />
                Online
              </span>
            </div>
            <div className="mt-2 text-[10px] text-muted-foreground font-mono">
              TPS: 2,458 | Latency: 14ms
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto relative">
        <div className="absolute inset-0 pointer-events-none bg-[url('/grid.svg')] opacity-10" />
        <div className="p-8 max-w-7xl mx-auto relative z-10">
          {children}
        </div>
      </main>
    </div>
  );
}
