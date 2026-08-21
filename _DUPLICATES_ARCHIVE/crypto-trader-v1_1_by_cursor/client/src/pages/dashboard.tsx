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
import { AlertCircle, Play, Pause, RefreshCw, Crosshair, TrendingUp, Wallet, ShieldCheck, Flame, Activity, Zap, Trophy, BarChart3, ShieldAlert, Clock, XCircle, RotateCcw } from "lucide-react";
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
