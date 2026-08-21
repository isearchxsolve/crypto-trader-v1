import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings as SettingsIcon, Save, Shield, TrendingUp, Crosshair, Activity, Brain, AlertTriangle, RefreshCw } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

interface EngineSettings {
  trailingStopActivation: number;
  trailingStopDistance: number;
  hardTakeProfit: number;
  stopLoss: number;
  maxHoldSeconds: number;
  maxOpenPositions: number;
  startingBalance: number;
  scanIntervalMs: number;
  priceCheckIntervalMs: number;
  minScoreToTrade: number;
  mlServiceUrl: string;
  mlWeight: number;
  scoreWeight: number;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  lossCooldownMs: number;
  partialTpRatio: number;
  partialTpThreshold: number;
  sniperMinScore: number;
  sniperMaxAge: number;
  sniperMinBuyPressure: number;
  sniperMinLiquidity: number;
  sniperMaxSize: number;
  mgMinScore: number;
  mgMinVolMomentum: number;
  mgMinPriceChange5m: number;
  mgMinTxVelocity: number;
  mgMaxSize: number;
  hwrMinScore: number;
  hwrMinBuyPressure5m: number;
  hwrMinBuyPressure1h: number;
  hwrMinLiquidity: number;
  hwrMaxSize: number;
  maxPositionSize: number;
  minPositionSize: number;
  maxTradesPerCycle: number;
  reentryDelayMs: number;
}

function SettingField({ label, description, value, onChange, type = "number", step, suffix, testId }: {
  label: string;
  description?: string;
  value: string | number;
  onChange: (val: string) => void;
  type?: string;
  step?: string;
  suffix?: string;
  testId: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <div className="flex items-center gap-2">
        <Input
          type={type}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-black/20 border-border/50 focus:border-primary/50"
          data-testid={testId}
        />
        {suffix && <span className="text-xs text-muted-foreground whitespace-nowrap">{suffix}</span>}
      </div>
    </div>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [localSettings, setLocalSettings] = useState<EngineSettings | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [adminSecret, setAdminSecret] = useState(() => localStorage.getItem("adminSecret") || "");

  const { data: settings, isLoading, error } = useQuery<EngineSettings>({
    queryKey: ["/api/settings"],
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (settings && !hasChanges) {
      setLocalSettings(settings);
    }
  }, [settings, hasChanges]);

  const saveMutation = useMutation({
    mutationFn: async (updates: Partial<EngineSettings>) => {
      const res = await apiRequest("POST", "/api/settings", updates);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/engine/stats"] });
      setLocalSettings(data);
      setHasChanges(false);
      toast({
        title: "Settings Saved",
        description: "Engine parameters updated in real-time",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to save",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function updateField(key: keyof EngineSettings, rawValue: string) {
    if (!localSettings) return;
    const currentType = typeof localSettings[key];
    let parsedValue: any;
    if (currentType === "number") {
      parsedValue = parseFloat(rawValue);
      if (isNaN(parsedValue)) return;
    } else {
      parsedValue = rawValue;
    }
    setLocalSettings({ ...localSettings, [key]: parsedValue });
    setHasChanges(true);
  }

  function handleSave() {
    if (!localSettings) return;
    saveMutation.mutate(localSettings);
  }

  function handleReset() {
    if (settings) {
      setLocalSettings(settings);
      setHasChanges(false);
    }
  }

  if (isLoading) {
    return (
      <Layout>
        <div className="space-y-6 max-w-4xl mx-auto">
          <div>
            <h1 className="text-3xl font-bold font-display uppercase tracking-widest text-white mb-2">
              System <span className="text-secondary text-glow">Configuration</span>
            </h1>
          </div>
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        </div>
      </Layout>
    );
  }

  if (error || !localSettings) {
    return (
      <Layout>
        <div className="flex h-full items-center justify-center">
          <div className="text-destructive flex flex-col items-center gap-4 border border-destructive/20 p-8 rounded-md bg-destructive/5">
            <AlertTriangle className="h-12 w-12" />
            <h2 className="text-xl font-bold uppercase" data-testid="text-settings-error">Failed to load settings</h2>
            <p className="text-sm text-muted-foreground">Could not connect to engine settings endpoint.</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6 max-w-4xl mx-auto">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-bold font-display uppercase tracking-widest text-white mb-2">
              System <span className="text-secondary text-glow">Configuration</span>
            </h1>
            <p className="text-muted-foreground text-sm font-mono">
              Engine parameters — changes take effect immediately.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Button
                variant="outline"
                onClick={handleReset}
                data-testid="button-reset-settings"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Discard
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={!hasChanges || saveMutation.isPending}
              data-testid="button-save-settings"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveMutation.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </div>
        </div>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-destructive" />
              Security
            </CardTitle>
            <CardDescription>Configure admin access for sensitive commands.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label className="text-sm font-medium">Admin Secret</Label>
                <p className="text-xs text-muted-foreground">Required for sensitive operations (matches ADMIN_SECRET)</p>
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={adminSecret}
                    onChange={(e) => {
                      setAdminSecret(e.target.value);
                      localStorage.setItem("adminSecret", e.target.value);
                    }}
                    className="bg-black/20 border-border/50 focus:border-primary/50"
                    placeholder="Enter admin secret..."
                    data-testid="input-admin-secret"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Exit Strategy
            </CardTitle>
            <CardDescription>Take profit, stop loss, and trailing stop parameters.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Hard Take Profit"
                description="Close position at this gain %"
                value={localSettings.hardTakeProfit}
                onChange={(v) => updateField("hardTakeProfit", v)}
                step="1"
                suffix="%"
                testId="input-hard-tp"
              />
              <SettingField
                label="Stop Loss"
                description="Close position at this loss %"
                value={localSettings.stopLoss}
                onChange={(v) => updateField("stopLoss", v)}
                step="1"
                suffix="%"
                testId="input-stop-loss"
              />
              <SettingField
                label="Max Hold Time"
                description="Force close if held too long"
                value={localSettings.maxHoldSeconds}
                onChange={(v) => updateField("maxHoldSeconds", v)}
                step="10"
                suffix="sec"
                testId="input-max-hold"
              />
              <SettingField
                label="Trailing Stop Activation"
                description="Enable trailing after this gain %"
                value={localSettings.trailingStopActivation}
                onChange={(v) => updateField("trailingStopActivation", v)}
                step="0.5"
                suffix="%"
                testId="input-trail-activation"
              />
              <SettingField
                label="Trailing Stop Distance"
                description="Trail distance from peak %"
                value={localSettings.trailingStopDistance}
                onChange={(v) => updateField("trailingStopDistance", v)}
                step="0.5"
                suffix="%"
                testId="input-trail-distance"
              />
              <SettingField
                label="Partial TP Threshold"
                description="Take partial profit at this %"
                value={localSettings.partialTpThreshold}
                onChange={(v) => updateField("partialTpThreshold", v)}
                step="1"
                suffix="%"
                testId="input-partial-tp-threshold"
              />
              <SettingField
                label="Partial TP Ratio"
                description="Fraction of position to close"
                value={localSettings.partialTpRatio}
                onChange={(v) => updateField("partialTpRatio", v)}
                step="0.05"
                suffix="ratio"
                testId="input-partial-tp-ratio"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crosshair className="h-5 w-5 text-secondary" />
              Position Sizing
            </CardTitle>
            <CardDescription>Control trade sizes and position limits.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Max Position Size"
                description="Maximum SOL per trade"
                value={localSettings.maxPositionSize}
                onChange={(v) => updateField("maxPositionSize", v)}
                step="0.1"
                suffix="SOL"
                testId="input-max-pos-size"
              />
              <SettingField
                label="Min Position Size"
                description="Minimum SOL per trade"
                value={localSettings.minPositionSize}
                onChange={(v) => updateField("minPositionSize", v)}
                step="0.01"
                suffix="SOL"
                testId="input-min-pos-size"
              />
              <SettingField
                label="Max Open Positions"
                description="Total concurrent trades"
                value={localSettings.maxOpenPositions}
                onChange={(v) => updateField("maxOpenPositions", v)}
                step="1"
                testId="input-max-positions"
              />
              <SettingField
                label="Max Trades/Cycle"
                description="New trades per scan cycle"
                value={localSettings.maxTradesPerCycle}
                onChange={(v) => updateField("maxTradesPerCycle", v)}
                step="1"
                testId="input-max-trades-cycle"
              />
              <SettingField
                label="Starting Balance"
                description="Paper trading initial balance"
                value={localSettings.startingBalance}
                onChange={(v) => updateField("startingBalance", v)}
                step="1"
                suffix="SOL"
                testId="input-starting-balance"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Scanner & Timing
            </CardTitle>
            <CardDescription>Scan intervals and minimum score thresholds.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Scan Interval"
                description="Time between market scans"
                value={localSettings.scanIntervalMs}
                onChange={(v) => updateField("scanIntervalMs", v)}
                step="1000"
                suffix="ms"
                testId="input-scan-interval"
              />
              <SettingField
                label="Price Check Interval"
                description="Time between position checks"
                value={localSettings.priceCheckIntervalMs}
                onChange={(v) => updateField("priceCheckIntervalMs", v)}
                step="1000"
                suffix="ms"
                testId="input-price-interval"
              />
              <SettingField
                label="Min Score to Trade"
                description="Minimum combined score"
                value={localSettings.minScoreToTrade}
                onChange={(v) => updateField("minScoreToTrade", v)}
                step="1"
                suffix="/100"
                testId="input-min-score"
              />
              <SettingField
                label="Re-entry Delay"
                description="Wait before re-trading same token"
                value={localSettings.reentryDelayMs}
                onChange={(v) => updateField("reentryDelayMs", v)}
                step="5000"
                suffix="ms"
                testId="input-reentry-delay"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-cyan-400" />
              ML & Scoring Weights
            </CardTitle>
            <CardDescription>Machine learning integration and score blending.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="ML Weight"
                description="ML prediction influence (0-1)"
                value={localSettings.mlWeight}
                onChange={(v) => updateField("mlWeight", v)}
                step="0.05"
                testId="input-ml-weight"
              />
              <SettingField
                label="Rule Score Weight"
                description="Rule-based score influence (0-1)"
                value={localSettings.scoreWeight}
                onChange={(v) => updateField("scoreWeight", v)}
                step="0.05"
                testId="input-score-weight"
              />
              <SettingField
                label="ML Service URL"
                description="XGBoost prediction service"
                value={localSettings.mlServiceUrl}
                onChange={(v) => updateField("mlServiceUrl", v)}
                type="text"
                testId="input-ml-url"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-orange-400" />
              Risk Management
            </CardTitle>
            <CardDescription>Circuit breakers, drawdown limits, and cooldowns.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Daily Loss Limit"
                description="Pause trading at this daily loss %"
                value={localSettings.dailyLossLimitPct}
                onChange={(v) => updateField("dailyLossLimitPct", v)}
                step="1"
                suffix="%"
                testId="input-daily-loss-limit"
              />
              <SettingField
                label="Max Drawdown"
                description="Pause trading at this drawdown %"
                value={localSettings.maxDrawdownPct}
                onChange={(v) => updateField("maxDrawdownPct", v)}
                step="1"
                suffix="%"
                testId="input-max-drawdown"
              />
              <SettingField
                label="Loss Cooldown"
                description="Pause after 3 consecutive losses"
                value={localSettings.lossCooldownMs}
                onChange={(v) => updateField("lossCooldownMs", v)}
                step="5000"
                suffix="ms"
                testId="input-loss-cooldown"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crosshair className="h-5 w-5 text-primary" />
              Strategy Thresholds — SNIPER
            </CardTitle>
            <CardDescription>Entry criteria for SNIPER mode (new tokens).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Min Score"
                value={localSettings.sniperMinScore}
                onChange={(v) => updateField("sniperMinScore", v)}
                step="1"
                testId="input-sniper-min-score"
              />
              <SettingField
                label="Max Age"
                description="Token age limit"
                value={localSettings.sniperMaxAge}
                onChange={(v) => updateField("sniperMaxAge", v)}
                step="10"
                suffix="sec"
                testId="input-sniper-max-age"
              />
              <SettingField
                label="Min Buy Pressure"
                value={localSettings.sniperMinBuyPressure}
                onChange={(v) => updateField("sniperMinBuyPressure", v)}
                step="0.01"
                testId="input-sniper-min-bp"
              />
              <SettingField
                label="Min Liquidity"
                value={localSettings.sniperMinLiquidity}
                onChange={(v) => updateField("sniperMinLiquidity", v)}
                step="100"
                suffix="USD"
                testId="input-sniper-min-liq"
              />
              <SettingField
                label="Max Size"
                value={localSettings.sniperMaxSize}
                onChange={(v) => updateField("sniperMaxSize", v)}
                step="0.1"
                suffix="SOL"
                testId="input-sniper-max-size"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-secondary" />
              Strategy Thresholds — MG (Momentum/Growth)
            </CardTitle>
            <CardDescription>Entry criteria for MG mode (momentum trades).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Min Score"
                value={localSettings.mgMinScore}
                onChange={(v) => updateField("mgMinScore", v)}
                step="1"
                testId="input-mg-min-score"
              />
              <SettingField
                label="Min Vol Momentum"
                value={localSettings.mgMinVolMomentum}
                onChange={(v) => updateField("mgMinVolMomentum", v)}
                step="0.1"
                testId="input-mg-min-vol"
              />
              <SettingField
                label="Min Price Change 5m"
                value={localSettings.mgMinPriceChange5m}
                onChange={(v) => updateField("mgMinPriceChange5m", v)}
                step="0.5"
                suffix="%"
                testId="input-mg-min-pc5m"
              />
              <SettingField
                label="Min TX Velocity"
                value={localSettings.mgMinTxVelocity}
                onChange={(v) => updateField("mgMinTxVelocity", v)}
                step="1"
                testId="input-mg-min-txv"
              />
              <SettingField
                label="Max Size"
                value={localSettings.mgMaxSize}
                onChange={(v) => updateField("mgMaxSize", v)}
                step="0.1"
                suffix="SOL"
                testId="input-mg-max-size"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/40 border-border/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Strategy Thresholds — HWR (High Win Rate)
            </CardTitle>
            <CardDescription>Entry criteria for HWR mode (high confidence).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SettingField
                label="Min Score"
                value={localSettings.hwrMinScore}
                onChange={(v) => updateField("hwrMinScore", v)}
                step="1"
                testId="input-hwr-min-score"
              />
              <SettingField
                label="Min Buy Pressure 5m"
                value={localSettings.hwrMinBuyPressure5m}
                onChange={(v) => updateField("hwrMinBuyPressure5m", v)}
                step="0.01"
                testId="input-hwr-min-bp5m"
              />
              <SettingField
                label="Min Buy Pressure 1h"
                value={localSettings.hwrMinBuyPressure1h}
                onChange={(v) => updateField("hwrMinBuyPressure1h", v)}
                step="0.01"
                testId="input-hwr-min-bp1h"
              />
              <SettingField
                label="Min Liquidity"
                value={localSettings.hwrMinLiquidity}
                onChange={(v) => updateField("hwrMinLiquidity", v)}
                step="500"
                suffix="USD"
                testId="input-hwr-min-liq"
              />
              <SettingField
                label="Max Size"
                value={localSettings.hwrMaxSize}
                onChange={(v) => updateField("hwrMaxSize", v)}
                step="0.1"
                suffix="SOL"
                testId="input-hwr-max-size"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3 pb-8">
          {hasChanges && (
            <Button
              variant="outline"
              onClick={handleReset}
              data-testid="button-reset-settings-bottom"
            >
              Discard Changes
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            data-testid="button-save-settings-bottom"
          >
            <Save className="h-4 w-4 mr-2" />
            {saveMutation.isPending ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </div>
    </Layout>
  );
}
