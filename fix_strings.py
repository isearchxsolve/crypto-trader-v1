"""
Fix all broken string literals in routes.ts caused by smart-quote-to-doublequote replacement.

For each broken line, the pattern is:
  "some text" rest of text"   <- original had a curly-quote used as separator, now has a plain "

Fix strategy:
- In comments: leave them (comments don't matter for parsing)
- In string literals: replace the lone interior " with ' -- '
"""

path = r'c:\Users\Admin\Downloads\god_ai\crypto-trader-v1_1\server\routes.ts'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Specific fixes for each broken line (line number -> replacement content)
# We do targeted line-by-line replacements to be safe

fixes = {
    25: '  log.warn("[SECURITY] ADMIN_SECRET env var is not set -- all admin endpoints are publicly accessible. Set ADMIN_SECRET before going live.");\n',
    32: '    res.status(403).json({ error: "Forbidden -- invalid admin secret" });\n',
    3073: '  } else log.info("[ENGINE] Live trading DISABLED -- paper mode only");\n',
    3476: '  log.info("[ENGINE] Switched to LIVE mode -- streak counters + circuit breaker + dailyPnlSol reset");\n',
    3497: '  log.info("[ENGINE] Streak manually reset -- consecutiveLosses=0");\n',
    3511: '    if (!jupiterService) return res.status(400).json({ error: "Live mode not active -- WALLET_PRIVATE_KEY not set" });\n',
}

# For comment-only lines, fix by replacing the stray " with ' --'
# These are safe to just fix in-place
comment_fixes = [257, 430, 468, 484, 524, 530, 2186, 2482, 2504, 2687, 2688, 2689, 2829, 2938, 2957, 3501]

changed = 0
for lineno, new_content in fixes.items():
    idx = lineno - 1
    old = lines[idx]
    lines[idx] = new_content
    print(f"L{lineno}: FIXED STRING")
    print(f"  OLD: {old.strip()[:80]}")
    print(f"  NEW: {new_content.strip()[:80]}")
    changed += 1

# For comment lines that have a stray " mid-line, replace it with ' --'
for lineno in comment_fixes:
    idx = lineno - 1
    line = lines[idx]
    # Replace stray double quotes inside comments (after //) with ' --'
    # Strategy: if line has a comment part, fix the quotes there
    # Actually simpler: just replace the pattern of `" word` (quote followed by space+word) 
    # with ` -- word` when NOT at the start/end of a proper string
    import re
    # Replace patterns like `" some text` that look like broken separators
    # These are all in comments so we can be aggressive
    fixed = re.sub(r'(?<!")\"\s+(?=[a-z])', ' -- ', line)
    if fixed != line:
        lines[idx] = fixed
        print(f"L{lineno}: FIXED COMMENT: {fixed.strip()[:80]}")
        changed += 1

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f"\nTotal lines fixed: {changed}")
