const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

const newListingBlock = `
        // ── Source 5: Birdeye New Listings (meme_platform_enabled=true) 
        if (birdeyeHasAvailableKey() && Date.now() >= birdeyeRateLimitedUntil) {
            try {
                const _bk3 = getNextBirdeyeKey();
                if (_bk3) {
                    const b3: any = await withTimeout(
                        fetch("https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20&meme_platform_enabled=true", {
                            headers: { "X-API-KEY": _bk3, "Accept": "application/json", "x-chain": "solana" },
                            signal: AbortSignal.timeout(8000),
                        }).then(async (r: any) => { if (!r.ok) return null; return r.json(); }),
                        10_000,
                        "Birdeye NewListing"
                    ).catch(() => null);
                    
                    const tokens3 = (b3?.data?.items) || [];
                    if (Array.isArray(tokens3)) {
                        for (const t of tokens3) {
                            const addr = t?.address || t?.tokenAddress || t?.mint;
                            if (typeof addr === "string" && addr.length >= 32 && addr.length <= 64) {
                                extraSourceAddrs.add(addr);
                            }
                        }
                    }
                }
            } catch (e: any) { console.warn("[SRC:BIRDEYE-NEW] failed:", e?.message || e); }
        }
`;

s = s.replace(
  /\/\/ AI-TUNE\(2026-06-24\): GeckoTerminal \/pools endpoint does NOT support sort=h24_volume_usd_desc;/,
  newListingBlock + "\n        // AI-TUNE(2026-06-24): GeckoTerminal /pools endpoint does NOT support sort=h24_volume_usd_desc;"
);

fs.writeFileSync(full, s, 'utf8');
console.log("Injected Birdeye /defi/v2/tokens/new_listing into routes.ts");
