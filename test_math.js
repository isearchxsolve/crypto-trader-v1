const liq = 15427;
const bp5m = 0.59;
const volMomentum = 5.81;
const priceChange5m = 49.90;
const txVelocity5m = 60; // assume max
const ageSeconds = 395;
const bp1h = 0.65; // assume max
const fdv = 15427; // assume fdvScore max
const h1b = 100, h1s = 50, vol1h = 1000, vol5m = 1000, m5b = 30, m5s = 30;

const liqScore = liq >= 50000 ? 15 : liq >= 20000 ? 12 : liq >= 10000 ? 10 : liq >= 5000 ? 8 : liq >= 2000 ? 5 : liq >= 1000 ? 3 : liq >= 500 ? 1 : 0;
const bpScore = bp5m >= 0.75 ? 20 : bp5m >= 0.65 ? 16 : bp5m >= 0.60 ? 13 : bp5m >= 0.55 ? 10 : bp5m >= 0.50 ? 5 : Math.max(0, Math.floor(bp5m * 10) - 5);
let volScore = volMomentum >= 3.0 ? 15 : volMomentum >= 2.0 ? 12 : volMomentum >= 1.5 ? 9 : volMomentum >= 1.0 ? 6 : volMomentum >= 0.5 ? 3 : 0;
let priceScore = priceChange5m >= 10 ? 15 : priceChange5m >= 7 ? 12 : priceChange5m >= 5 ? 10 : priceChange5m >= 3 ? 8 : priceChange5m >= 1.5 ? 5 : priceChange5m > 0 ? 2 : Math.max(-10, Math.floor(priceChange5m));

if (liq < 30000) {
  volScore = Math.floor(volScore / 3);
  priceScore = Math.floor(priceScore / 3);
}

const txScore = txVelocity5m >= 50 ? 10 : txVelocity5m >= 30 ? 8 : txVelocity5m >= 20 ? 6 : txVelocity5m >= 10 ? 4 : txVelocity5m >= 5 ? 2 : 0;
const ageScore = ageSeconds < 60 ? 10 : ageSeconds <= 300 ? 8 : ageSeconds <= 600 ? 6 : ageSeconds <= 1800 ? 4 : ageSeconds <= 3600 ? 2 : 0;
const bp1hScore = bp1h >= 0.60 ? 5 : bp1h >= 0.55 ? 3 : bp1h >= 0.50 ? 1 : 0;

let fdvScore = 0;
if (fdv > 0 && liq > 0) { const lr = liq / fdv; fdvScore = lr >= 0.05 ? 5 : lr >= 0.02 ? 3 : lr >= 0.01 ? 1 : 0; }

const rawTotal = liqScore + bpScore + volScore + priceScore + txScore + ageScore + bp1hScore + fdvScore;
const score = Math.max(0, Math.min(100, Math.round((rawTotal / 95) * 100)));

console.log("liqScore:", liqScore);
console.log("bpScore:", bpScore);
console.log("volScore:", volScore);
console.log("priceScore:", priceScore);
console.log("txScore:", txScore);
console.log("ageScore:", ageScore);
console.log("bp1hScore:", bp1hScore);
console.log("fdvScore:", fdvScore);
console.log("rawTotal:", rawTotal);
console.log("FINAL SCORE:", score);
