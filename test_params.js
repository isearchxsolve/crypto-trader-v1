// Fixed parameter extraction function
function extractParam(name) {
  const content = fs.readFileSync(ROUTES_FILE, 'utf8');
  const re = new RegExp(`\b${name}\s*:\s*([\d.]+)`);
  const match = content.match(re);
  const val = match ? match[1] : null;
  if (val !== null) {
    return parseFloat(val);
  }
  return null;
}

// Test extraction
console.log('extractParam("minScoreToTrade"):', extractParam('minScoreToTrade'));
console.log('extractParam("sniperMinBuyPressure"):', extractParam('sniperMinBuyPressure'));
console.log('extractParam("mgMinVolMomentum"):', extractParam('mgMinVolMomentum'));
console.log('extractParam("sniperMaxAge"):', extractParam('sniperMaxAge'));
console.log('extractParam("stopLoss"):', extractParam('stopLoss'));
console.log('extractParam("trailingStopActivation"):', extractParam('trailingStopActivation'));

console.log('\n=== PARAMS LOADED ===');
for (const [key, def] of Object.entries(PARAMS)) {
  console.log(key + ':', def.current);
}
