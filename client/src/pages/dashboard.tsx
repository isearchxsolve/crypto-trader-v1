import { Layout } from "@/components/layout";
import { StatCard } from "@/components/stat-card";
import { LiveFeedTable } from "@/components/live-feed-table";
import { useBotStatus, useTrades, useCandidates, useLiveCandidates, useEngineStats } from "@/hooks/use-bot-data";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Play, Pause, RefreshCw, Crosshair, TrendingUp, Wallet, ShieldCheck, Flame, Activity, Zap, Trophy, BarChart3, ShieldAlert, Clock, XCircle, RotateCcw, Eye, EyeOff, Gauge, GitBranch, Timer, ArrowUpDown, CheckCircle2, AlertTriangle, Wifi } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export default function Dashboard() {
  const { data: status, isLoading: statusLoading, error: statusError } = useBotStatus();
  const { data: trades, isLoading: tradesLoading } = useTrades();
  const { data: candidates, isLoading: candidatesLoading } = useCandidates();
  const { data: liveCandidates, isLoading: liveLoading } = useLiveCandidates();
  const { data: engineStats } = useEngineStats();
  const { data: riskStatus } = useQuery({ queryKey: ["/api/engine/risk-status"], refetchInterval: 3000 });
  const { data: shadowData, refetch: refetchShadow } = useQuery({ queryKey: ["/api/shadow/trades"], refetchInterval: 5000 });
  const { data: latencyData, refetch: refetchLatency } = useQuery({ queryKey: ["/api/latency/log"], refetchInterval: 4000 });
  const { toast } = useToast();
  const [showLiveConfirm, setShowLiveConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const toggleTradingMode = useMutation({
    mutationFn: async (mode: string) => {
      const res = await apiRequest("POST", "/api/bot/trading-mode", { mode, confirmed: mode === "live" });
      return res.json();
    },
    onSuccess: (_, mode) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({
        title: mode === "live" ? "LIVE Trading Activated" : "Paper Trading Activated",
        description: mode === "live" ? "Real SOL will be used for transactions" : "Switched to simulated trading",
        variant: mode === "live" ? "destructive" : "default",
      });
    },
  });

  const toggleBot = useMutation({
    mutationFn: async (isRunning: boolean) => {
      const res = await apiRequest("POST", "/api/bot/toggle", { isRunning });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
    },
    onError: (err: any) => {
      toast({ title: "Command Failed", description: err.message || "Could not toggle bot", variant: "destructive" });
    },
  });

  const changeStrategy = useMutation({
    mutationFn: async (mode: string) => {
      const res = await apiRequest("POST", "/api/bot/strategy-mode", { mode });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      toast({ title: "Strategy Updated" });
    },
  });

  const forceSellAll = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/force-sell-all", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/engine/stats"] });
      toast({
        title: "All Positions Closed",
        description: `Sold ${data.closedCount} positions | Balance: ${data.newBalance} SOL`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Sell All Failed", description: err.message || "Could not close positions", variant: "destructive" });
    },
  });

  const resetBalance = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/reset-balance", {});
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bot/trades"] });
      queryClient.invalidateQueries({ queryKey: ["/api/engine/stats"] });
      setShowResetConfirm(false);
      toast({
        title: "Balance Reset",
        description: `Paper balance reset to ${data.newBalance} SOL`,
      });
    },
    onError: (err: any) => {
      setShowResetConfirm(false);
      toast({ title: "Reset Failed", description: err.message || "Could not reset balance", variant: "destructive" });
    },
  });

  const toggleShadow = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/shadow/toggle", { enabled });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/shadow/trades"] });
      toast({ title: data.shadowModeEnabled ? "Shadow Mode Enabled" : "Shadow Mode Disabled" });
    },
  });

  const clearLatency = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/latency/log", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/latency/log"] });
      toast({ title: "Latency Log Cleared" });
    },
  });

  if (statusError) {
    return (
      <Layout>
        <div className="flex h-full items-center justify-center">
          <div className="text-destructive flex flex-col items-center gap-4 border border-destructive/20 p-8 rounded-lg bg-destructive/5">
            <AlertCircle className="h-12 w-12" />
            <h2 className="text-xl font-bold uppercase" data-testid="text-error-title">System Malfunction</h2>
            <p>Could not connect to bot mainframe. Check server connection.</p>
          </div>
        </div>
      </Layout>
    );
  }

  const tradeList = Array.isArray(trades) ? trades : [];
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const liveList = Array.isArray(liveCandidates) ? liveCandidates : [];

  const isRunning = status?.isRunning ?? false;
  const currentMode = status?.mode ?? "IDLE";
  const tradingMode = status?.tradingMode ?? "paper";
  const walletBalance = status?.walletBalance ?? "0.00";
  const totalPnl = status?.totalPnl ?? "0.00";
  const winRate = status?.winRate ?? "0";
  const totalTrades = status?.totalTrades ?? 0;
  const openPositions = status?.openPositions ?? 0;
  const lastSignal = status?.lastSignal ?? null;
  const isLive = tradingMode === "live";

  const drawdownPct = Number(engineStats?.drawdownPct || 0);
  const dailyPnl = Number(engineStats?.dailyPnlSol || 0);
  const solPerHour = Number(engineStats?.solPerHour || 0);
  const uptimeMinutes = Math.floor((engineStats?.uptimeSeconds || 0) / 60);

  return (
    <Layout>
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
          <div>
            <h1 className="text-3xl font-bold font-display uppercase tracking-widest text-white" data-testid="text-page-title">
              Command <span className="text-primary text-glow">Center</span>
            </h1>
            <p className="text-muted-foreground mt-1 text-sm font-mono flex items-center gap-2">
              Engine: <span className="text-primary">{engineStats?.engineVersion || "4.0+ML"}</span>
              <span className="text-muted-foreground/50">|</span>
              Uptime: <span className="text-primary">{uptimeMinutes}m</span>
              {engineStats?.mlServiceActive && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="text-cyan-400">ML Active</span>
                </>
              )}
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className={cn(
              "flex items-center gap-3 px-4 py-2 rounded-lg border transition-all",
              isLive
                ? "border-destructive/50 bg-destructive/10 shadow-[0_0_20px_-5px_rgba(239,68,68,0.4)]"
                : "border-primary/50 bg-primary/10 shadow-[0_0_20px_-5px_rgba(38,217,98,0.3)]"
            )}>
              <Label htmlFor="trading-mode-toggle" className={cn(
                "text-xs font-bold uppercase tracking-wider cursor-pointer",
                !isLive ? "text-primary" : "text-muted-foreground"
              )}>
                Paper
              </Label>
              <Switch
                id="trading-mode-toggle"
                data-testid="switch-trading-mode"
                checked={isLive}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setShowLiveConfirm(true);
                  } else {
                    toggleTradingMode.mutate("paper");
                  }
                }}
                disabled={toggleTradingMode.isPending}
              />
              <Label htmlFor="trading-mode-toggle" className={cn(
                "text-xs font-bold uppercase tracking-wider cursor-pointer",
                isLive ? "text-destructive" : "text-muted-foreground"
              )}>
                Live
              </Label>
              {isLive && (
                <span className="ml-1 block h-2 w-2 rounded-full bg-destructive animate-pulse" />
              )}
            </div>

            <Select value={currentMode} onValueChange={(v) => changeStrategy.mutate(v)}>
              <SelectTrigger className="w-[130px] bg-black/40 border-border/50" data-testid="select-strategy-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">AUTO</SelectItem>
                <SelectItem value="SNIPER">SNIPER</SelectItem>
                <SelectItem value="MG">MG</SelectItem>
                <SelectItem value="HWR">HWR</SelectItem>
              </SelectContent>
            </Select>

            <Button
              data-testid="button-toggle-bot"
              onClick={() => toggleBot.mutate(!isRunning)}
              disabled={toggleBot.isPending}
              className={isRunning
                ? "bg-destructive text-white hover:bg-destructive/80 shadow-[0_0_20px_-5px_rgba(239,68,68,0.5)]"
                : "bg-primary text-black hover:bg-primary/90 shadow-[0_0_20px_-5px_rgba(38,217,98,0.5)]"
              }
            >
              {isRunning ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
              {isRunning ? "STOP" : "START"}
            </Button>

            <Button
              data-testid="button-force-sell"
              variant="outline"
              size="sm"
              onClick={() => forceSellAll.mutate()}
              disabled={forceSellAll.isPending || openPositions === 0}
              className="border-orange-500/50 text-orange-400 hover:bg-orange-500/20 text-xs"
            >
              <XCircle className="mr-1 h-3 w-3" />
              Sell All
            </Button>

            <Button
              data-testid="button-reset-balance"
              variant="outline"
              size="sm"
              onClick={() => setShowResetConfirm(true)}
              disabled={resetBalance.isPending}
              className="border-muted-foreground/30 text-muted-foreground hover:bg-white/5 text-xs"
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              Reset
            </Button>
          </div>
        </div>

        {isLive && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-center gap-3"
          >
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0" />
            <p className="text-sm text-destructive font-mono" data-testid="text-live-warning">
              LIVE TRADING ACTIVE — Real SOL will be used for transactions.
            </p>
          </motion.div>
        )}

        {(riskStatus as any)?.circuitBreakerActive && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3 flex items-center gap-3"
          >
            <ShieldAlert className="h-5 w-5 text-orange-400 flex-shrink-0" />
            <p className="text-sm text-orange-400 font-mono" data-testid="text-circuit-breaker">
              CIRCUIT BREAKER ACTIVE — Trading paused: {(riskStatus as any)?.reason}
            </p>
          </motion.div>
        )}

        {lastSignal && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-primary/5 border border-primary/20 rounded-lg px-4 py-2 flex items-center gap-3"
          >
            <Activity className="h-4 w-4 text-primary animate-pulse" />
            <p className="text-sm font-mono text-primary" data-testid="text-last-signal">
              {lastSignal}
            </p>
          </motion.div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatCard
            label="Strategy"
            value={currentMode}
            icon={Crosshair}
            color="secondary"
            animate={true}
          />
          <StatCard
            label="Mode"
            value={isLive ? "LIVE" : "PAPER"}
            icon={isLive ? Zap : ShieldCheck}
            color={isLive ? "destructive" : "primary"}
            animate={true}
          />
          <StatCard
            label="Balance"
            value={`${Number(walletBalance).toFixed(2)} SOL`}
            subValue={engineStats?.totalPnlSol ? `${Number(engineStats.totalPnlSol) >= 0 ? '+' : ''}${Number(engineStats.totalPnlSol).toFixed(3)} SOL` : undefined}
            icon={Wallet}
            animate={true}
          />
          <StatCard
            label="Daily P&L"
            value={`${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(3)} SOL`}
            subValue={`${engineStats?.dailyTradeCount || 0} trades today`}
            icon={BarChart3}
            trend={dailyPnl >= 0 ? "up" : "down"}
            color={dailyPnl >= 0 ? "primary" : "destructive"}
            animate={true}
          />
          <StatCard
            label="SOL/Hour"
            value={`${solPerHour >= 0 ? '+' : ''}${solPerHour.toFixed(3)}`}
            subValue={`${uptimeMinutes}m uptime`}
            icon={Clock}
            color={solPerHour >= 0 ? "primary" : "destructive"}
            animate={true}
          />
          <StatCard
            label="Win Rate"
            value={`${Number(winRate).toFixed(1)}%`}
            subValue={`${engineStats?.wins || 0}W / ${engineStats?.losses || 0}L`}
            icon={Trophy}
            color={Number(winRate) >= 50 ? "primary" : "default"}
            animate={true}
          />
          <StatCard
            label="Positions"
            value={`${openPositions} / ${10}`}
            subValue={`streak: ${engineStats?.consecutiveWins ? `${engineStats.consecutiveWins}W` : engineStats?.consecutiveLosses ? `${engineStats.consecutiveLosses}L` : '0'}`}
            icon={Activity}
            color={openPositions > 0 ? "secondary" : "default"}
            animate={true}
          />
          <StatCard
            label="Drawdown"
            value={`${drawdownPct.toFixed(1)}%`}
            subValue={`peak: ${engineStats?.peakBalance || '10.000'} SOL`}
            icon={ShieldAlert}
            color={drawdownPct > 20 ? "destructive" : drawdownPct > 10 ? "secondary" : "default"}
            animate={true}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {engineStats?.bestTrade && (
            <Card className="bg-card/40 border-primary/20 backdrop-blur-sm">
              <CardContent className="pt-3 pb-2 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Best Trade</p>
                  <p className="text-base font-bold text-primary font-mono" data-testid="text-best-trade">
                    +{Number(engineStats.bestTrade.pnl).toFixed(1)}% <span className="text-xs text-muted-foreground">${engineStats.bestTrade.symbol}</span>
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          {engineStats?.worstTrade && (
            <Card className="bg-card/40 border-destructive/20 backdrop-blur-sm">
              <CardContent className="pt-3 pb-2 flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-destructive/20 flex items-center justify-center flex-shrink-0">
                  <AlertCircle className="h-4 w-4 text-destructive" />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Worst Trade</p>
                  <p className="text-base font-bold text-destructive font-mono" data-testid="text-worst-trade">
                    {Number(engineStats.worstTrade.pnl).toFixed(1)}% <span className="text-xs text-muted-foreground">${engineStats.worstTrade.symbol}</span>
                  </p>
                </div>
              </CardContent>
            </Card>
          )}
          <Card className="bg-card/40 border-border/30 backdrop-blur-sm">
            <CardContent className="pt-3 pb-2 flex items-center gap-3">
              <div className={cn(
                "h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0",
                (riskStatus as any)?.circuitBreakerActive ? "bg-orange-500/20" : "bg-primary/10"
              )}>
                <ShieldCheck className={cn(
                  "h-4 w-4",
                  (riskStatus as any)?.circuitBreakerActive ? "text-orange-400" : "text-primary"
                )} />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Risk Status</p>
                <p className={cn(
                  "text-sm font-bold font-mono",
                  (riskStatus as any)?.circuitBreakerActive ? "text-orange-400" : "text-primary"
                )} data-testid="text-risk-status">
                  {(riskStatus as any)?.circuitBreakerActive ? "PAUSED" : "OK"}
                  <span className="text-xs text-muted-foreground ml-2">
                    DD: {(riskStatus as any)?.drawdownPct || '0'}% | Daily: {(riskStatus as any)?.dailyLossPct || '0'}%
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="live-scanner" className="space-y-4">
          <TabsList className="bg-black/40 border border-border/50 p-1">
            <TabsTrigger
              value="live-scanner"
              data-testid="tab-live-scanner"
              className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary font-display uppercase tracking-wider"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Live Scanner
              {liveList.length > 0 && (
                <Badge variant="outline" className="ml-2 border-primary/50 text-primary text-[10px] px-1.5 py-0">
                  {liveList.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="trades"
              data-testid="tab-trades"
              className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary font-display uppercase tracking-wider"
            >
              <Activity className="mr-2 h-4 w-4" />
              Trade History
            </TabsTrigger>
            <TabsTrigger
              value="candidates"
              data-testid="tab-candidates"
              className="data-[state=active]:bg-secondary/20 data-[state=active]:text-secondary font-display uppercase tracking-wider"
            >
              <Flame className="mr-2 h-4 w-4" />
              Candidates
            </TabsTrigger>
            <TabsTrigger
              value="shadow"
              data-testid="tab-shadow"
              className="data-[state=active]:bg-cyan-500/20 data-[state=active]:text-cyan-400 font-display uppercase tracking-wider"
            >
              <Eye className="mr-2 h-4 w-4" />
              Shadow
              {(shadowData as any)?.summary?.totalShadowTrades > 0 && (
                <Badge variant="outline" className="ml-2 border-cyan-500/50 text-cyan-400 text-[10px] px-1.5 py-0">
                  {(shadowData as any).summary.totalShadowTrades}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="latency"
              data-testid="tab-latency"
              className="data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-400 font-display uppercase tracking-wider"
            >
              <Gauge className="mr-2 h-4 w-4" />
              Latency
            </TabsTrigger>
          </TabsList>

          <TabsContent value="live-scanner" className="space-y-4">
            <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-display uppercase tracking-wider flex items-center gap-2">
                  <RefreshCw className={cn("h-5 w-5 text-primary", liveLoading && "animate-spin")} />
                  DexScreener Live Feed
                  {engineStats?.mlServiceActive && (
                    <Badge variant="outline" className="text-[10px] border-cyan-500/50 text-cyan-400 bg-cyan-500/10" data-testid="badge-ml-active">
                      ML ACTIVE
                    </Badge>
                  )}
                  <Badge variant="outline" className="ml-auto text-[10px] border-primary/50 text-primary" data-testid="badge-live-source">
                    REAL-TIME DATA
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {liveLoading ? (
                  <div className="h-40 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/50 bg-black/20 backdrop-blur-sm overflow-hidden">
                    <Table>
                      <TableHeader className="bg-white/5">
                        <TableRow className="border-border/50 hover:bg-transparent">
                          <TableHead className="text-xs font-bold uppercase tracking-wider">Token</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Price</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Liquidity</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-center">Score</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Vol 5m</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Buys/Sells</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">5m</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Age</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider">Signal</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {liveList.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={9} className="text-center h-24 text-muted-foreground" data-testid="text-no-live">
                              Connecting to DexScreener API...
                            </TableCell>
                          </TableRow>
                        ) : (
                          liveList.map((token: any, i: number) => {
                            const priceNum = Number(token.price);
                            const priceStr = priceNum < 0.0001
                              ? priceNum.toExponential(2)
                              : priceNum < 1
                                ? `$${priceNum.toFixed(6)}`
                                : `$${priceNum.toFixed(2)}`;
                            const pChange = Number(token.priceChange5m || 0);

                            return (
                              <motion.tr
                                key={`${token.tokenAddress}-${i}`}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: i * 0.03 }}
                                className="border-border/40 hover:bg-white/5 transition-colors"
                                data-testid={`row-live-${i}`}
                              >
                                <TableCell>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-sm">
                                      <span className="text-primary">$</span>{token.tokenSymbol}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground font-mono">
                                      {token.tokenAddress?.substring(0, 6)}...{token.tokenAddress?.substring(token.tokenAddress.length - 4)}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">{priceStr}</TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  ${Number(token.liquidity).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-center">
                                  <div className="flex flex-col items-center gap-0.5">
                                    <div className={cn(
                                      "inline-flex items-center gap-1 text-[11px] font-bold font-mono px-2 py-0.5 rounded",
                                      (token.score || 0) >= 85 ? "bg-primary/20 text-primary" :
                                      (token.score || 0) >= 70 ? "bg-yellow-500/20 text-yellow-400" :
                                      (token.score || 0) >= 50 ? "bg-orange-500/20 text-orange-400" :
                                      "bg-white/5 text-muted-foreground"
                                    )}>
                                      {token.score || 0}/100
                                    </div>
                                    {token.mlActive && token.mlScore !== null && token.mlScore !== undefined && (
                                      <span className="text-[9px] font-mono text-cyan-400">ML:{token.mlScore}%</span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  ${Number(token.volume5m || 0).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  <span className="text-primary">{token.buys5m || 0}</span>
                                  <span className="text-muted-foreground">/</span>
                                  <span className="text-destructive">{token.sells5m || 0}</span>
                                </TableCell>
                                <TableCell className={cn(
                                  "text-right font-mono text-xs font-bold",
                                  pChange > 0 ? "text-primary" : pChange < 0 ? "text-destructive" : "text-muted-foreground"
                                )}>
                                  {pChange > 0 ? "+" : ""}{pChange.toFixed(1)}%
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                  {token.ageSeconds < 60
                                    ? `${token.ageSeconds}s`
                                    : token.ageSeconds < 3600
                                      ? `${Math.floor(token.ageSeconds / 60)}m`
                                      : token.ageSeconds < 86400
                                        ? `${Math.floor(token.ageSeconds / 3600)}h`
                                        : `${Math.floor(token.ageSeconds / 86400)}d`
                                  }
                                </TableCell>
                                <TableCell>
                                  {token.qualifiedMode ? (
                                    <Badge variant="outline" className="text-[10px] border-primary/50 text-primary animate-pulse">
                                      {token.qualifiedMode}
                                    </Badge>
                                  ) : (
                                    <span className="text-muted-foreground text-xs">--</span>
                                  )}
                                </TableCell>
                              </motion.tr>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trades" className="space-y-4">
            <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-display uppercase tracking-wider flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" />
                  Execution Log
                  <Badge variant="outline" className="text-[10px] text-muted-foreground ml-auto">
                    {tradeList.length} trades
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {tradesLoading ? (
                  <div className="h-40 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  </div>
                ) : (
                  <LiveFeedTable trades={tradeList} />
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="candidates" className="space-y-4">
            <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg font-display uppercase tracking-wider flex items-center gap-2">
                  <Flame className="h-5 w-5 text-secondary" />
                  Detected Opportunities
                </CardTitle>
              </CardHeader>
              <CardContent>
                {candidatesLoading ? (
                  <div className="h-40 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-secondary"></div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/50 bg-black/20 backdrop-blur-sm overflow-hidden">
                    <Table>
                      <TableHeader className="bg-white/5">
                        <TableRow className="border-border/50 hover:bg-transparent">
                          <TableHead className="text-xs font-bold uppercase tracking-wider">Token</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider">Address</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Liquidity</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Pump Prob.</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Dump Risk</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Age</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider">Qualified</TableHead>
                          <TableHead className="text-xs font-bold uppercase tracking-wider text-right">Action</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {candidateList.length === 0 ? (
                           <TableRow>
                             <TableCell colSpan={8} className="text-center h-24 text-muted-foreground" data-testid="text-no-candidates">
                               Scanning mempool for new pairs...
                             </TableCell>
                           </TableRow>
                        ) : (
                          candidateList.map((cand: any, i: number) => (
                            <motion.tr
                              key={cand.id}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: i * 0.05 }}
                              className="border-border/40 hover:bg-white/5 transition-colors"
                              data-testid={`row-candidate-${cand.id}`}
                            >
                              <TableCell className="font-bold">
                                <span className="text-secondary">$</span>{cand.tokenSymbol}
                              </TableCell>
                              <TableCell className="font-mono text-xs text-muted-foreground">
                                {cand.tokenAddress.substring(0, 4)}...{cand.tokenAddress.substring(cand.tokenAddress.length - 4)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm">${Number(cand.liquidity).toLocaleString()}</TableCell>
                              <TableCell className="text-right">
                                <Badge variant="outline" className={cn(
                                  "border-0 font-bold",
                                  Number(cand.pumpProbability) > 0.8 ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                                )}>
                                  {(Number(cand.pumpProbability) * 100).toFixed(0)}%
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Badge variant="outline" className={cn(
                                  "border-0 font-bold",
                                  Number(cand.dumpRisk) < 0.2 ? "bg-primary/20 text-primary" : "bg-destructive/20 text-destructive"
                                )}>
                                  {(Number(cand.dumpRisk || 0) * 100).toFixed(0)}%
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                {cand.ageSeconds}s
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-[10px] border-secondary/50 text-secondary">
                                  {cand.qualifiedMode || "---"}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right">
                                <Button size="sm" variant="secondary" className="h-7 text-xs bg-secondary/20 hover:bg-secondary/40 text-secondary border border-secondary/50" data-testid={`button-snipe-${cand.id}`}>
                                  SNIPE
                                </Button>
                              </TableCell>
                            </motion.tr>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── SHADOW MODE ─────────────────────────────────────────────── */}
          <TabsContent value="shadow" className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                {
                  label: "Trades Analysed",
                  value: (shadowData as any)?.summary?.totalShadowTrades ?? "—",
                  icon: Eye,
                  color: "text-cyan-400",
                  bg: "bg-cyan-500/10 border-cyan-500/20",
                },
                {
                  label: "Avg Paper PnL",
                  value: (shadowData as any)?.summary?.totalShadowTrades
                    ? `${(shadowData as any).summary.avgPaperPnlPct >= 0 ? "+" : ""}${(shadowData as any).summary.avgPaperPnlPct}%`
                    : "—",
                  icon: TrendingUp,
                  color: (shadowData as any)?.summary?.avgPaperPnlPct >= 0 ? "text-primary" : "text-destructive",
                  bg: "bg-primary/10 border-primary/20",
                },
                {
                  label: "Avg Shadow PnL",
                  value: (shadowData as any)?.summary?.totalShadowTrades
                    ? `${(shadowData as any).summary.avgShadowPnlPct >= 0 ? "+" : ""}${(shadowData as any).summary.avgShadowPnlPct}%`
                    : "—",
                  icon: GitBranch,
                  color: (shadowData as any)?.summary?.avgShadowPnlPct >= 0 ? "text-primary" : "text-destructive",
                  bg: "bg-card/40 border-border/50",
                },
                {
                  label: "Paper Inflation",
                  value: (shadowData as any)?.summary?.totalShadowTrades
                    ? `${(shadowData as any).summary.avgPnlGapPct >= 0 ? "+" : ""}${(shadowData as any).summary.avgPnlGapPct}%`
                    : "—",
                  icon: ArrowUpDown,
                  color: Number((shadowData as any)?.summary?.avgPnlGapPct) > 5
                    ? "text-orange-400"
                    : Number((shadowData as any)?.summary?.avgPnlGapPct) > 2
                      ? "text-yellow-400"
                      : "text-primary",
                  bg: Number((shadowData as any)?.summary?.avgPnlGapPct) > 5
                    ? "bg-orange-500/10 border-orange-500/20"
                    : "bg-card/40 border-border/50",
                },
              ].map((card, i) => (
                <Card key={i} className={cn("backdrop-blur-sm border", card.bg)}>
                  <CardContent className="pt-3 pb-3 flex items-center gap-3">
                    <div className={cn("h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0", card.bg)}>
                      <card.icon className={cn("h-4 w-4", card.color)} />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{card.label}</p>
                      <p className={cn("text-lg font-bold font-mono", card.color)}>{String(card.value)}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Interpretation banner */}
            {(shadowData as any)?.summary?.interpretation && (
              <div className={cn(
                "rounded-lg border px-4 py-3 flex items-center gap-3 text-sm font-mono",
                Number((shadowData as any).summary.avgPnlGapPct) > 5
                  ? "bg-orange-500/10 border-orange-500/30 text-orange-400"
                  : "bg-cyan-500/10 border-cyan-500/30 text-cyan-400"
              )}>
                {Number((shadowData as any).summary.avgPnlGapPct) > 5
                  ? <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  : <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                }
                {(shadowData as any).summary.interpretation}
                <span className="ml-auto text-muted-foreground text-xs">
                  avg impact: {(shadowData as any).summary.avgPriceImpactPct}% | avg quote: {(shadowData as any).summary.avgQuoteFetchMs}ms | avg hops: {(shadowData as any).summary.avgRouteHops}
                </span>
              </div>
            )}

            {/* Controls */}
            <div className="flex items-center gap-3">
              <div className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-mono",
                (shadowData as any)?.enabled ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400" : "bg-muted border-border/50 text-muted-foreground"
              )}>
                {(shadowData as any)?.enabled ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                Shadow {(shadowData as any)?.enabled ? "ON" : "OFF"}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10 text-xs h-8"
                onClick={() => toggleShadow.mutate(!(shadowData as any)?.enabled)}
                disabled={toggleShadow.isPending}
              >
                {(shadowData as any)?.enabled ? "Disable Shadow" : "Enable Shadow"}
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-8 text-muted-foreground ml-auto" onClick={() => refetchShadow()}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
              </Button>
            </div>

            {/* Open shadow trades */}
            {(shadowData as any)?.open?.length > 0 && (
              <Card className="bg-card/40 border-cyan-500/20 backdrop-blur-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-display uppercase tracking-wider text-cyan-400 flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Open Shadow Positions ({(shadowData as any).open.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-white/5">
                        <TableRow className="border-border/40 hover:bg-transparent">
                          <TableHead className="text-[10px] uppercase tracking-wider">Token</TableHead>
                          <TableHead className="text-[10px] uppercase tracking-wider text-right">Paper Entry</TableHead>
                          <TableHead className="text-[10px] uppercase tracking-wider text-right">Shadow Entry</TableHead>
                          <TableHead className="text-[10px] uppercase tracking-wider text-right">Impact</TableHead>
                          <TableHead className="text-[10px] uppercase tracking-wider text-right">Route</TableHead>
                          <TableHead className="text-[10px] uppercase tracking-wider text-right">Quote ms</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(shadowData as any).open.map((t: any) => (
                          <TableRow key={t.id} className="border-border/30 hover:bg-white/5">
                            <TableCell className="font-bold text-cyan-400">
                              <span className="text-muted-foreground text-[10px] mr-1">{t.mode}</span>${t.tokenSymbol}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">${Number(t.paperEntryPrice).toExponential(4)}</TableCell>
                            <TableCell className="text-right font-mono text-xs text-orange-400">${Number(t.shadowEntryPrice).toExponential(4)}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              <span className={t.quoteImpactPct > 3 ? "text-orange-400" : "text-primary"}>
                                {t.quoteImpactPct.toFixed(2)}%
                              </span>
                            </TableCell>
                            <TableCell className="text-right font-mono text-[10px] text-muted-foreground">
                              {t.routeLabel} ({t.routeHops}h)
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              <span className={t.quoteDurationMs > 800 ? "text-orange-400" : "text-muted-foreground"}>
                                {t.quoteDurationMs}ms
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Closed shadow trades */}
            <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-display uppercase tracking-wider flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-cyan-400" />
                  Shadow vs Paper — Closed Trades
                  <Badge variant="outline" className="ml-auto text-[10px] border-cyan-500/30 text-cyan-400">
                    last {Math.min((shadowData as any)?.closed?.length ?? 0, 50)}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-white/5">
                      <TableRow className="border-border/40 hover:bg-transparent">
                        <TableHead className="text-[10px] uppercase tracking-wider">Token</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Paper PnL</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Shadow PnL</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Gap</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Impact</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Hops</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider">Exit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!(shadowData as any)?.closed?.length ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center h-20 text-muted-foreground text-sm">
                            No closed shadow trades yet — runs alongside paper trades automatically
                          </TableCell>
                        </TableRow>
                      ) : (
                        [...((shadowData as any).closed)].reverse().map((t: any) => {
                          const gap = Number(t.pnlGapPct ?? 0);
                          return (
                            <TableRow key={t.id} className="border-border/30 hover:bg-white/5">
                              <TableCell className="font-bold text-xs">
                                <div className="flex flex-col">
                                  <span><span className="text-cyan-400">$</span>{t.tokenSymbol}</span>
                                  <span className="text-[9px] text-muted-foreground">{t.mode} #{t.id}</span>
                                </div>
                              </TableCell>
                              <TableCell className={cn("text-right font-mono text-xs font-bold", Number(t.paperPnlPct) >= 0 ? "text-primary" : "text-destructive")}>
                                {Number(t.paperPnlPct) >= 0 ? "+" : ""}{Number(t.paperPnlPct ?? 0).toFixed(2)}%
                              </TableCell>
                              <TableCell className={cn("text-right font-mono text-xs font-bold", Number(t.shadowPnlPct) >= 0 ? "text-primary" : "text-destructive")}>
                                {Number(t.shadowPnlPct) >= 0 ? "+" : ""}{Number(t.shadowPnlPct ?? 0).toFixed(2)}%
                              </TableCell>
                              <TableCell className={cn(
                                "text-right font-mono text-xs font-bold",
                                gap > 5 ? "text-orange-400" : gap > 2 ? "text-yellow-400" : "text-muted-foreground"
                              )}>
                                {gap >= 0 ? "+" : ""}{gap.toFixed(2)}%
                              </TableCell>
                              <TableCell className={cn("text-right font-mono text-xs", t.quoteImpactPct > 3 ? "text-orange-400" : "text-muted-foreground")}>
                                {Number(t.quoteImpactPct).toFixed(2)}%
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                {t.routeHops}
                              </TableCell>
                              <TableCell className="text-[10px] text-muted-foreground max-w-[100px] truncate">
                                {t.exitReason}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── LATENCY TAB ─────────────────────────────────────────────── */}
          <TabsContent value="latency" className="space-y-4">
            {/* Latency summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                {
                  label: "Quote Fetch",
                  avg: (latencyData as any)?.latency?.quoteFetch?.avgMs,
                  p90: (latencyData as any)?.latency?.quoteFetch?.p90Ms,
                  warn: 800, danger: 1500,
                  note: "Jupiter API response time",
                  icon: Wifi,
                },
                {
                  label: "Quote Age @ Send",
                  avg: (latencyData as any)?.latency?.quoteAgeAtSend?.avgMs,
                  p90: (latencyData as any)?.latency?.quoteAgeAtSend?.p90Ms,
                  warn: 1000, danger: 1500,
                  note: "Staleness when tx sent",
                  icon: Timer,
                },
                {
                  label: "TX Confirm",
                  avg: (latencyData as any)?.latency?.txConfirm?.avgMs,
                  p90: (latencyData as any)?.latency?.txConfirm?.p90Ms,
                  warn: 2000, danger: 4000,
                  note: "Send → on-chain confirmed",
                  icon: CheckCircle2,
                },
                {
                  label: "Total Round-Trip",
                  avg: (latencyData as any)?.latency?.totalRoundTrip?.avgMs,
                  p90: (latencyData as any)?.latency?.totalRoundTrip?.p90Ms,
                  warn: 3000, danger: 6000,
                  note: "Quote start → confirmed",
                  icon: Gauge,
                },
              ].map((m, i) => {
                const avgVal = m.avg ?? 0;
                const color = avgVal >= m.danger ? "text-destructive" : avgVal >= m.warn ? "text-orange-400" : "text-primary";
                const border = avgVal >= m.danger ? "border-destructive/30 bg-destructive/5" : avgVal >= m.warn ? "border-orange-500/30 bg-orange-500/5" : "border-border/50 bg-card/40";
                return (
                  <Card key={i} className={cn("backdrop-blur-sm border", border)}>
                    <CardContent className="pt-3 pb-3">
                      <div className="flex items-center gap-2 mb-2">
                        <m.icon className={cn("h-3.5 w-3.5", color)} />
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.label}</p>
                      </div>
                      <p className={cn("text-2xl font-bold font-mono", color)}>
                        {m.avg != null ? `${m.avg}ms` : "—"}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        p90: <span className="font-mono">{m.p90 != null ? `${m.p90}ms` : "—"}</span>
                      </p>
                      <p className="text-[9px] text-muted-foreground/60 mt-1">{m.note}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Success rate bar */}
            {(latencyData as any)?.totalRecords > 0 && (
              <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground uppercase tracking-wider font-mono">TX Success Rate</span>
                    <span className={cn(
                      "text-lg font-bold font-mono",
                      Number((latencyData as any).successRate) >= 80 ? "text-primary" : Number((latencyData as any).successRate) >= 60 ? "text-orange-400" : "text-destructive"
                    )}>
                      {(latencyData as any).successRate}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {(latencyData as any).successCount} ok / {(latencyData as any).failCount} failed / {(latencyData as any).totalRecords} total
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: (latencyData as any).successRate }}
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Controls */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground font-mono">
                {(latencyData as any)?.totalRecords ?? 0} records in log
              </span>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 text-xs h-8 ml-auto"
                onClick={() => clearLatency.mutate()}
                disabled={clearLatency.isPending}
              >
                <XCircle className="h-3 w-3 mr-1" /> Clear Log
              </Button>
              <Button size="sm" variant="ghost" className="text-xs h-8 text-muted-foreground" onClick={() => refetchLatency()}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
              </Button>
            </div>

            {/* Recent errors */}
            {(latencyData as any)?.recentErrors?.length > 0 && (
              <Card className="bg-destructive/5 border-destructive/20 backdrop-blur-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-display uppercase tracking-wider text-destructive flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    Recent TX Failures ({(latencyData as any).recentErrors.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader className="bg-white/5">
                      <TableRow className="border-border/40 hover:bg-transparent">
                        <TableHead className="text-[10px] uppercase tracking-wider">Token</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Duration</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider">Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(latencyData as any).recentErrors.map((e: any, i: number) => (
                        <TableRow key={i} className="border-border/30 hover:bg-white/5">
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {e.tokenMint?.slice(0, 8)}...
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-orange-400">
                            {e.totalMs}ms
                          </TableCell>
                          <TableCell className="font-mono text-xs text-destructive max-w-[300px] truncate">
                            {e.error}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Recent latency records */}
            <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-display uppercase tracking-wider flex items-center gap-2">
                  <Timer className="h-4 w-4 text-orange-400" />
                  Recent Executions (last 30)
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-white/5">
                      <TableRow className="border-border/40 hover:bg-transparent">
                        <TableHead className="text-[10px] uppercase tracking-wider">Token</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Quote</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Age@Send</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Confirm</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Total</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-right">Impact</TableHead>
                        <TableHead className="text-[10px] uppercase tracking-wider text-center">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!(latencyData as any)?.recentRecords?.length ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center h-20 text-muted-foreground text-sm">
                            No executions recorded yet — latency data appears after first live trade
                          </TableCell>
                        </TableRow>
                      ) : (
                        [...((latencyData as any).recentRecords)].reverse().map((r: any, i: number) => (
                          <TableRow key={i} className="border-border/30 hover:bg-white/5">
                            <TableCell className="font-mono text-[10px] text-muted-foreground">
                              {r.tokenMint?.slice(0, 8)}...
                            </TableCell>
                            <TableCell className={cn("text-right font-mono text-xs", r.quoteDurationMs > 800 ? "text-orange-400" : "text-muted-foreground")}>
                              {r.quoteDurationMs}ms
                            </TableCell>
                            <TableCell className={cn("text-right font-mono text-xs", r.quoteAgeAtSendMs > 1200 ? "text-orange-400" : "text-muted-foreground")}>
                              {r.quoteAgeAtSendMs}ms
                            </TableCell>
                            <TableCell className={cn("text-right font-mono text-xs", r.confirmDurationMs > 3000 ? "text-orange-400" : "text-muted-foreground")}>
                              {r.confirmDurationMs > 0 ? `${r.confirmDurationMs}ms` : "—"}
                            </TableCell>
                            <TableCell className={cn(
                              "text-right font-mono text-xs font-bold",
                              r.totalDurationMs > 5000 ? "text-destructive" : r.totalDurationMs > 3000 ? "text-orange-400" : "text-foreground"
                            )}>
                              {r.totalDurationMs}ms
                            </TableCell>
                            <TableCell className={cn("text-right font-mono text-xs", r.priceImpactPct > 3 ? "text-orange-400" : "text-muted-foreground")}>
                              {Number(r.priceImpactPct).toFixed(2)}%
                            </TableCell>
                            <TableCell className="text-center">
                              {r.success
                                ? <CheckCircle2 className="h-3.5 w-3.5 text-primary mx-auto" />
                                : <AlertCircle className="h-3.5 w-3.5 text-destructive mx-auto" />
                              }
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>
      </div>

      <AlertDialog open={showLiveConfirm} onOpenChange={setShowLiveConfirm}>
        <AlertDialogContent className="bg-card border-destructive/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2" data-testid="text-live-confirm-title">
              <Zap className="h-5 w-5" />
              Enable LIVE Trading?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>This will switch the bot to execute real transactions on Solana mainnet using your configured wallet.</p>
              <ul className="list-disc list-inside text-sm space-y-1 text-destructive/80">
                <li>Real SOL will be spent on trades</li>
                <li>Trades are irreversible once confirmed on-chain</li>
                <li>Ensure your private key and RPC are properly configured</li>
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-live">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-live"
              className="bg-destructive text-white hover:bg-destructive/80"
              onClick={() => toggleTradingMode.mutate("live")}
            >
              I understand, enable LIVE trading
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <AlertDialogContent className="bg-card border-orange-500/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-orange-400 flex items-center gap-2" data-testid="text-reset-confirm-title">
              <RotateCcw className="h-5 w-5" />
              Reset Paper Balance?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will close all open positions and reset your paper balance to 10 SOL. Trade history will be preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reset">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-reset"
              className="bg-orange-500 text-white hover:bg-orange-600"
              onClick={() => resetBalance.mutate()}
            >
              Reset Balance
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
