import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal } from "lucide-react";

export default function Logs() {
  const dummyLogs = [
    { time: "10:42:15", type: "INFO", msg: "Scanning block 245192831..." },
    { time: "10:42:18", type: "INFO", msg: "Found 2 new token pairs" },
    { time: "10:42:18", type: "WARN", msg: "Token $PEPE2 liquidity too low (0.5 SOL), skipping" },
    { time: "10:42:19", type: "SUCCESS", msg: "Snipe target acquired: $BONK2 - 85% score" },
    { time: "10:42:21", type: "INFO", msg: "Transaction sent: signature 5xJ9...kL2m" },
    { time: "10:42:24", type: "SUCCESS", msg: "Transaction confirmed! Bought 15,000 $BONK2 @ 0.000045" },
    { time: "10:45:10", type: "INFO", msg: "Monitoring price action..." },
    { time: "10:48:30", type: "INFO", msg: "Price update: +20% PNL" },
  ];

  return (
    <Layout>
      <div className="h-full flex flex-col">
        <h1 className="text-3xl font-bold font-display uppercase tracking-widest text-white mb-6">
          System <span className="text-primary text-glow">Logs</span>
        </h1>

        <Card className="flex-1 bg-black/60 border-border/50 backdrop-blur-sm border-l-4 border-l-primary/50">
          <CardHeader className="py-4 border-b border-border/30 bg-white/5">
            <CardTitle className="text-sm font-mono flex items-center gap-2 text-muted-foreground">
              <Terminal className="h-4 w-4" />
              /var/log/sniper-bot.log
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 h-[calc(100vh-250px)]">
            <ScrollArea className="h-full p-4 font-mono text-xs md:text-sm">
              {dummyLogs.map((log, i) => (
                <div key={i} className="mb-1 flex gap-3 hover:bg-white/5 px-2 py-0.5 rounded transition-colors">
                  <span className="text-muted-foreground opacity-50">{log.time}</span>
                  <span className={
                    log.type === "INFO" ? "text-blue-400" :
                    log.type === "WARN" ? "text-yellow-400" :
                    log.type === "SUCCESS" ? "text-primary" : "text-white"
                  }>
                    [{log.type}]
                  </span>
                  <span className="text-foreground/90">{log.msg}</span>
                </div>
              ))}
              <div className="h-4 w-2 bg-primary animate-pulse inline-block ml-2 mt-2" />
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
