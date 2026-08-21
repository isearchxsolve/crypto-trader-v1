"""
Fix routes.ts: the encoding script replaced smart-quote chars (U+201C/U+201D) that were INSIDE
JS string literals with plain double-quotes, breaking those strings.

Strategy: restore the broken string literals. The smart quotes in source code were used as em-dash 
variants in log message strings. We can fix by replacing the broken patterns with proper escaped 
string content using '--' (which is what the em-dash should have been replaced with anyway).

The actual broken pattern is: a string like
  log.warn("[SECURITY] ADMIN_SECRET env var is not set " all admin endpoints ...");
where the original had an em-dash inside the string literal which got converted to a regular
double-quote, splitting the string.

We need to find these broken patterns and fix them by replacing the errant " with ' -- '
"""

import re

path = r'c:\Users\Admin\Downloads\god_ai\crypto-trader-v1_1\server\routes.ts'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

# The broken patterns look like:
# "some text" rest of text in same string"
# where the middle " was originally a smart-quote (em-dash variant) 
# 
# Approach: use TypeScript/esbuild to find the line numbers, then fix manually.
# First let's find lines with odd quote counts in string literals

lines = content.split('\n')
issues = []
for i, line in enumerate(lines, 1):
    stripped = line.strip()
    if stripped.startswith('//'):
        continue
    # Count double-quotes (rough check)
    in_template = '`' in line
    if in_template:
        continue
    # Remove escaped quotes
    cleaned = line.replace('\\"', '').replace("\\'", '')
    dq = cleaned.count('"')
    if dq > 0 and dq % 2 != 0:
        issues.append((i, line))

print(f"Found {len(issues)} potentially broken lines:")
for lineno, line in issues[:30]:
    print(f"  L{lineno}: {line.strip()[:100]}")
