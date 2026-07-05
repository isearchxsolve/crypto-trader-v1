#!/usr/bin/env python3
"""
analyze_log.py -- objective read on the bot's behavior from a session log.

Usage:
    python analyze_log.py tsxlog.txt                 # single session
    python analyze_log.py baseline.txt enabled.txt    # A/B compare (flags off vs on)

Parses the canonical lines emitted by routes.ts:
    [EXIT][<REASON>] $SYM pnl=<n>pct trail=...pct peak=...pct
    [PAPER] WIN|LOSS SELL $SYM ... PNL: <n>%
    [SCORE-BREAKDOWN] $SYM combined=<NN> raw=...           (entry score, for labeling)
    [GOLD-ENTRY] ENTERING/BOUGHT/PAPER ENTER
No external deps.

The SCORE-BAND report is the key Lever-1 unlock: it joins each token's entry
combinedScore to its realized exit pnl, giving the EMPIRICAL score->expectancy
slope that entry_sim.ts had to assume. Run one paper session, then this turns the
'how predictive is the score' question from a guess into a measured number, which
is the ONLY safe basis for recalibrating the scorer.
"""
import sys, re, statistics

EXIT_RE   = re.compile(r"\[EXIT\]\[([^\]]+)\]\s+\$(\S+).*?pnl=([+-]?\d+(?:\.\d+)?)pct", re.I)
PAPER_RE  = re.compile(r"\[PAPER\]\s+(?:WIN|LOSS)\s+SELL\s+\$(\S+).*?PNL:\s*([+-]?\d+(?:\.\d+)?)%", re.I)
SCORE_RE  = re.compile(r"\[SCORE-BREAKDOWN\]\s+\$(\S+)\s+combined=(\d+)", re.I)
ENTER_RE  = re.compile(r"\[GOLD-ENTRY\].*(ENTERING|BOUGHT|PAPER ENTER)")
NEW_BRANCHES = ("COST_AWARE_STOP", "DIP_RECOVERY_FAILED")
BANDS = [(0,79,"<80 (excluded band)"),(80,82,"80-82"),(83,85,"83-85"),(86,89,"86-89"),(90,200,"90+")]

def reason_key(raw: str) -> str:
    return re.split(r"[ (]", raw.strip(), maxsplit=1)[0]

def parse(path):
    exits, entries = [], 0
    last_score = {}        # symbol -> most recent entry combinedScore
    labeled = []           # (score, pnl) joined pairs
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            ms = SCORE_RE.search(line)
            if ms:
                last_score[ms.group(1)] = int(ms.group(2)); continue
            m = EXIT_RE.search(line)
            if not m:
                mp = PAPER_RE.search(line)
                if mp:
                    sym, pnl = mp.group(1), float(mp.group(2))
                    if sym in last_score: labeled.append((last_score[sym], pnl))
                    continue
            if m:
                reason, sym, pnl = reason_key(m.group(1)), m.group(2), float(m.group(3))
                exits.append((reason, pnl))
                if sym in last_score: labeled.append((last_score[sym], pnl))
                continue
            if ENTER_RE.search(line):
                entries += 1
    return exits, entries, labeled

def score_band_report(labeled):
    print("\n  SCORE-BAND EXPECTANCY  (entry combinedScore -> realized exit pnl)")
    if not labeled:
        print("    (no joined pairs -- need [SCORE-BREAKDOWN] AND exit lines for the same $SYM)")
        print("    tip: keep SCORE_BREAKDOWN_LOG=true (default) so entry scores are logged.")
        return
    print("    %-22s %5s %7s %10s %10s" % ("band","n","win%","avg pnl","median"))
    print("    " + "-"*60)
    rows = []
    for lo, hi, name in BANDS:
        v = [p for s, p in labeled if lo <= s <= hi]
        if not v: continue
        w = 100.0*len([x for x in v if x>0])/len(v)
        avg = sum(v)/len(v)
        rows.append((name, len(v), w, avg))
        print("    %-22s %5d %6.0f%% %9.2f%% %9.2f%%" % (name, len(v), w, avg, statistics.median(v)))
    # crude monotonicity / slope read
    pos = [r for r in rows if r[3] > 0]; neg = [r for r in rows if r[3] <= 0]
    print("    " + "-"*60)
    if rows:
        lo_band = min(rows, key=lambda r: r[3]); hi_band = max(rows, key=lambda r: r[3])
        print(f"    edge slope read: worst band '{lo_band[0]}' {lo_band[3]:+.2f}%  ->  best band '{hi_band[0]}' {hi_band[3]:+.2f}%")
        print("    => if higher bands are clearly more positive, the score has real predictive power")
        print("       and tightening MIN_SCORE / recalibrating weights is justified BY THIS DATA.")

def report(path):
    exits, entries, labeled = parse(path)
    n = len(exits)
    print("\n" + "="*70)
    print(f"FILE: {path}")
    print(f"entries seen: {entries}    exits parsed: {n}    score-labeled exits: {len(labeled)}")
    if n == 0:
        print("  (no [EXIT] lines found -- check the log path / that the engine traded)")
        return None
    pnls = [p for _, p in exits]
    wins = [p for p in pnls if p > 0]
    print(f"WIN RATE:    {100.0*len(wins)/n:5.1f}%   ({len(wins)}/{n})")
    print(f"EXPECTANCY:  {sum(pnls)/n:+.2f}% avg pnl/trade   |   total pnl sum: {sum(pnls):+.1f}%")
    print(f"  best {max(pnls):+.1f}%  worst {min(pnls):+.1f}%  median {statistics.median(pnls):+.2f}%")
    by = {}
    for r, p in exits: by.setdefault(r, []).append(p)
    print("\n  %-26s %5s %7s %9s %9s %9s" % ("EXIT REASON","n","win%","avg","median","sum"))
    print("  " + "-"*68)
    for r in sorted(by, key=lambda k: -len(by[k])):
        v = by[r]; w = 100.0*len([x for x in v if x>0])/len(v)
        tag = "  <== NEW" if r in NEW_BRANCHES else ""
        print("  %-26s %5d %6.0f%% %8.2f%% %8.2f%% %8.1f%%%s" % (r, len(v), w, sum(v)/len(v), statistics.median(v), sum(v), tag))
    print("\n  NEW-BRANCH FIRING CHECK:")
    for nb in NEW_BRANCHES:
        c = len(by.get(nb, []))
        flag = "DIP_RECOVERY_ENABLED" if nb.startswith("DIP") else "COST_AWARE_STOP_ENABLED"
        if c == 0:
            print(f"    {nb:24s} 0 fires  -> NOT firing. Is {flag}=true set on the TSX server process?")
        else:
            print(f"    {nb:24s} {c} fires -> WIRED OK (branch is reachable & active)")
    score_band_report(labeled)
    return {"n": n, "win_rate": 100.0*len(wins)/n, "expectancy": sum(pnls)/n, "by": by}

def compare(a, b):
    if not a or not b: return
    print("\n" + "#"*70)
    print("A/B COMPARISON  (file1 = baseline, file2 = enabled)")
    print("#"*70)
    print(f"  win rate:    {a['win_rate']:5.1f}%  ->  {b['win_rate']:5.1f}%   ({b['win_rate']-a['win_rate']:+.1f} pts)")
    print(f"  expectancy:  {a['expectancy']:+.2f}%  ->  {b['expectancy']:+.2f}%   ({b['expectancy']-a['expectancy']:+.2f} pts/trade)")
    print("  NOTE: trust this only with a comparable sample size on BOTH sides (aim for >=50 exits each).")

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(1)
    results = [report(p) for p in args]
    if len(args) == 2: compare(results[0], results[1])
    print()

if __name__ == "__main__":
    main()
