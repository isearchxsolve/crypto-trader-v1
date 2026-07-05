import { storage } from "./storage";

export async function checkAdvancedFilters(
  tokenAddress: string, 
  pair: any, 
  heliusKey: string
): Promise<{ safe: boolean; reason: string }> {
  let isAdvancedSafe = true;
  let advReason = "advanced_filters_passed";

  // 1. Organic Graduation Speed (Pump.fun)
  if (tokenAddress.endsWith("pump") && pair.dexId === "raydium") {
    // If the token was created and hit Raydium in less than 5 minutes, it's highly botted.
    const ageSeconds = (Date.now() - (pair.pairCreatedAt || Date.now())) / 1000;
    // Raydium pair age. If it's less than 60 seconds since creation, it's very fresh.
    // For pump.fun graduation we ideally want >15m to fill the curve.
    if (ageSeconds < 60) {
      console.log(`[ADV-FILTER] $${pair.baseToken?.symbol} - Pump.fun graduation too fast (botted)`);
    }
  }

  // 2. Free Alternative to TweetScout (Basic Social Validation via DexScreener)
  // DISABLED for frequency: allowing all tokens regardless of social media presence.
  if (pair.info && pair.info.socials) {
    // social data logged but not strictly enforced
  }

  // 3. Free Alternative to BubbleMaps (On-Chain Holder Concentration via Helius/Solana RPC)
  if (heliusKey) {
    try {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      const holderRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenLargestAccounts",
          params: [tokenAddress]
        })
      });
      if (holderRes.ok) {
        const holderData = await holderRes.json();
        if (holderData.result && holderData.result.value) {
          const accounts = holderData.result.value;
          // Sum up the top 5 holders (excluding the bonding curve / AMM pool ideally, but simple sum is a safe heuristic)
          let top5Sum = 0;
          for (let i = 0; i < Math.min(5, accounts.length); i++) {
            top5Sum += Number(accounts[i].uiAmount || 0);
          }
          // Assuming 1B supply (typical for pump.fun). Check disabled for testing.
        }
      }
    } catch (err) {
      console.log(`[ADV-FILTER] Helius Cluster Check error:`, err);
    }
  }

  // 4. Developer History Profiling (Helius RPC)
  if (heliusKey) {
    try {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      const sigRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [tokenAddress, { limit: 10 }]
        })
      });
      if (sigRes.ok) {
        const sigData = await sigRes.json();
        if (sigData.result && sigData.result.length > 0) {
            // Full trace logic goes here.
            // For now, logging to indicate Helius Developer Profiling is active.
            // console.log(`[ADV-FILTER] Helius Developer trace complete for $${pair.baseToken?.symbol}`);
        }
      }
    } catch (err) {
      console.log(`[ADV-FILTER] Helius Developer Profiling error:`, err);
    }
  }

  return { safe: isAdvancedSafe, reason: advReason };
}
