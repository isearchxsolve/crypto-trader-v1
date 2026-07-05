const fs = require('fs');
const path = require('path');

const target = path.join('server', 'routes.ts');
const full = path.resolve(process.cwd(), target);

let s = fs.readFileSync(full, 'utf8');

s = s.replace(
  /const geckoTrendingPages = \[[^\]]+\];/,
  "const geckoTrendingPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];"
);
s = s.replace(
  /const geckoNewPages = \[[^\]]+\];/,
  "const geckoNewPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];"
);

const newQueries = `const SEARCH_QUERIES = [
  "raydium sol", "meteora sol", "orca sol", "solana usdc", "sol usdt",
  "raydium usdc", "orca usdc", "meteora usdc", "raydium usdt", "orca usdt",
  "sol usdc", "pumpswap sol", "pumpswap usdc", "pump fun sol",
  "pumpswap usdt", "pumpswap pump", "pumpswap meteora", "pumpswap raydium",
  "pump fun usdc", "pump fun usdt",
  "raydium clmm", "raydium amm", "meteora dlmm", "meteora damm",
  "orca whirlpool", "lifinity sol", "phoenix sol", "openbook sol",
  "dog sol", "cat sol", "ai sol", "pepe sol", "wif sol", "meme sol", "moon sol", "agent sol"
];`;

s = s.replace(/const SEARCH_QUERIES = \[\s*[\s\S]*?\];/m, newQueries);

fs.writeFileSync(full, s, 'utf8');
console.log("Boosted API discovery funnel in routes.ts.");
