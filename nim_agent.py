#!/usr/bin/env python3
"""
NIM Agent v2.1 — Safe, Fast, Good-Looking
- Token-bucket RPM enforcement (default 40, configurable)
- Dynamic profiles (any number, user-defined)
- Concurrency cap + jitter + Retry-After respect
- Stream telemetry to prevent "silent hang" illusions
- Lean Input / Fat Output optimization for fast TTFT
- Mid-stream overload protection and auto-retry
- Rich-powered terminal UI (falls back to plain ANSI if `rich` is missing)
"""

import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

try:
    from rich.console import Console, Group
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
    from rich.rule import Rule
    from rich.live import Live
    from rich.markdown import Markdown
    from rich.syntax import Syntax
    from rich.padding import Padding
    from rich.theme import Theme
    from rich.box import ROUNDED, SQUARE
    HAS_RICH = True
except ImportError:
    HAS_RICH = False

# Windows ANSI color support
if sys.platform == "win32":
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass

LEGACY_WIN_CONSOLE = (
    sys.platform == "win32"
    and not os.environ.get("WT_SESSION")
    and not os.environ.get("ANSICON")
    and os.environ.get("ConEmuANSI") != "ON"
    and not os.environ.get("TERM_PROGRAM")
)

# ───────────────────────────────────────────
# THEME (only meaningful when rich is available)
# ───────────────────────────────────────────
if HAS_RICH:
    THEME = Theme({
        "accent":     "bold #7aa2f7",
        "accent.dim": "#7aa2f7",
        "ok":         "bold #9ece6a",
        "warn":       "bold #e0af68",
        "err":        "bold #f7768e",
        "muted":      "#565f89",
        "label":      "bold #c0caf5",
        "value":      "#a9b1d6",
        "think":      "italic #bb9af7",
        "tool":       "bold #e0af68",
        "assistant":  "#c0caf5",
        "border":     "#3b4261",
        "title":      "bold #7aa2f7",
    })
    console = Console(theme=THEME, highlight=False)
else:
    console = None

# ───────────────────────────────────────────
# ANSI COLORS & ICONS (used for the plain fallback path)
# ───────────────────────────────────────────
class C:
    RESET = "\033[0m"; BOLD = "\033[1m"; DIM = "\033[2m"
    RED = "\033[31m"; GREEN = "\033[32m"; YELLOW = "\033[33m"
    BLUE = "\033[34m"; MAGENTA = "\033[35m"; CYAN = "\033[36m"
    WHITE = "\033[37m"
    BRED = "\033[91m"; BGREEN = "\033[92m"; BYELLOW = "\033[93m"
    BBLUE = "\033[94m"; BMAGENTA = "\033[95m"; BCYAN = "\033[96m"
    BWHITE = "\033[97m"

I = {
    "bot": "»", "brain": "◆", "code": "▸", "bug": "×", "rocket": "»", "check": "✓",
    "cross": "✗", "warn": "!", "info": "i", "sparkle": "*", "gear": "⚙", "file": "▤",
    "folder": "▸", "search": "?", "git": "±", "test": "✓", "run": "▶", "save": "↓",
    "key": "•", "star": "*", "clock": "~", "target": "◎", "bulb": "*", "tools": "⚙"
}
if LEGACY_WIN_CONSOLE:
    for k in I:
        I[k] = {"check": "[OK]", "cross": "[X]", "warn": "[!]"}.get(k, I[k])

# ───────────────────────────────────────────
# UI HELPERS — every call routes through Rich if present, else plain ANSI
# ───────────────────────────────────────────
def ok(msg: str):
    if HAS_RICH:
        console.print(f"  [ok]✓[/ok] [value]{esc(msg)}[/value]")
    else:
        print(f"  {C.BGREEN}{C.BOLD}✓{C.RESET} {msg}")

def err(msg: str):
    if HAS_RICH:
        console.print(f"  [err]✗[/err] [value]{esc(msg)}[/value]")
    else:
        print(f"  {C.BRED}{C.BOLD}✗{C.RESET} {msg}")

def warn(msg: str):
    if HAS_RICH:
        console.print(f"  [warn]![/warn] [value]{esc(msg)}[/value]")
    else:
        print(f"  {C.BYELLOW}{C.BOLD}!{C.RESET} {msg}")

def info(msg: str):
    if HAS_RICH:
        console.print(f"  [accent]i[/accent] [value]{esc(msg)}[/value]")
    else:
        print(f"  {C.BCYAN}{C.BOLD}ℹ{C.RESET} {msg}")

def sep(title: str = ""):
    if HAS_RICH:
        console.print(Rule(title, style="border", characters="─") if title else Rule(style="border", characters="─"))
    else:
        print(f"{C.DIM}────────────────────────────────────────────────────────────{C.RESET}")

def esc(s: str) -> str:
    """Escape rich markup metacharacters in dynamic strings."""
    return s.replace("[", "\\[") if HAS_RICH else s

def banner(subtitle: str = ""):
    if HAS_RICH:
        title = Text("NIM AGENT", style="title")
        title.append("  v2.1", style="muted")
        body = Group(title, Text(subtitle, style="muted")) if subtitle else title
        console.print(Panel(body, box=ROUNDED, border_style="border", padding=(0, 2)))
    else:
        print(f"{C.BMAGENTA}{C.BOLD}NIM AGENT v2.1{C.RESET}")
        if subtitle:
            print(f"{C.DIM}{subtitle}{C.RESET}")

# ───────────────────────────────────────────
# PATHS
# ───────────────────────────────────────────
CONFIG_FILE = Path.home() / ".nim_agent_config.json"
SESSIONS_FILE = Path.home() / ".nim_agent_sessions.json"
HISTORY_FILE = Path.home() / ".nim_agent_history.json"
NIM_BASE = "https://integrate.api.nvidia.com/v1"

# ───────────────────────────────────────────
# TOKEN BUCKET RATE LIMITER
# ───────────────────────────────────────────
class TokenBucket:
    def __init__(self, rpm: float = 20.0, burst: int = 1, min_gap: float = 1.0, safety_margin: float = 0.8):
        self.ceiling_rpm = max(1.0, rpm)
        self.rpm = self.ceiling_rpm * safety_margin
        self.burst = burst
        self.base_min_gap = min_gap
        self.tokens = float(burst)
        self.last_update = time.monotonic()
        self.last_request_time = 0.0
        self.lock = threading.Lock()
        self.history = deque()

    def _refill(self):
        now = time.monotonic()
        elapsed = now - self.last_update
        self.tokens = min(self.burst, self.tokens + elapsed * (self.rpm / 60.0))
        self.last_update = now

    def _prune(self):
        cutoff = time.monotonic() - 60.0
        while self.history and self.history[0] < cutoff:
            self.history.popleft()

    def _wait_time(self) -> float:
        self._refill()
        self._prune()
        waits = []
        if self.tokens < 1.0:
            waits.append((1.0 - self.tokens) / (self.rpm / 60.0))
        if len(self.history) >= max(1, int(self.rpm)):
            if self.history:
                waits.append(60.0 - (time.monotonic() - self.history[0]) + 0.5)
        since_last = time.monotonic() - self.last_request_time
        if since_last < self.base_min_gap:
            waits.append(self.base_min_gap - since_last)
        return max(waits) if waits else 0.0

    def reserve(self, timeout: float = 60.0) -> bool:
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            with self.lock:
                wait = self._wait_time()
                if wait <= 0.01:
                    self.tokens -= 1.0
                    self.last_request_time = time.monotonic()
                    return True
            time.sleep(wait)
        return False

    def commit(self):
        with self.lock:
            self.history.append(time.monotonic())

    def stats(self) -> str:
        with self.lock:
            self._prune()
            return f"{len(self.history)}/{int(self.ceiling_rpm)} RPM | gap:{self.base_min_gap}s"


class TokenMeter:
    def __init__(self):
        self.total_prompt = 0
        self.total_completion = 0
        self.lock = threading.Lock()

    def record(self, p: int, c: int):
        with self.lock:
            self.total_prompt += max(0, p)
            self.total_completion += max(0, c)

# ───────────────────────────────────────────
# PROVIDER POOL
# ───────────────────────────────────────────
OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENROUTER_FREE_MODELS = [
    ("OR-Nemotron-3-Ultra", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    ("OR-Kimi-K2.6", "moonshotai/kimi-k2.6:free"),
    ("OR-Qwen3-Coder", "qwen/qwen3-coder:free"),
]


class Provider:
    def __init__(self, name: str, base_url: str, api_key: str, model_id: str, rpm: float):
        self.name = name
        self.base_url = base_url
        self.api_key = api_key
        self.model_id = model_id
        self.bucket = TokenBucket(rpm=rpm, min_gap=1.0)
        self.client = OpenAI(base_url=base_url, api_key=api_key, timeout=300) if HAS_OPENAI else None
        self.cooldown_until = 0.0

    def is_available(self) -> bool:
        return time.monotonic() >= self.cooldown_until

    def record_success(self):
        self.bucket.commit()

    def record_rejection(self):
        self.cooldown(60.0)

    def cooldown(self, seconds: float = 60.0):
        self.cooldown_until = time.monotonic() + seconds


class ProviderPool:
    def __init__(self, providers: List[Provider]):
        self.providers = providers
        self.idx = 0

    def current(self) -> Provider:
        return self.providers[self.idx]

    def rotate(self):
        self.idx = (self.idx + 1) % len(self.providers)

    def next_available(self) -> Optional[Provider]:
        for _ in range(len(self.providers)):
            p = self.current()
            if p.is_available():
                return p
            self.rotate()
        return None

    def wait_time(self) -> float:
        waits = [max(0.0, p.cooldown_until - time.monotonic()) for p in self.providers]
        return min(waits) if waits else 5.0


def build_provider_pool(profile: Dict) -> ProviderPool:
    m = profile["models"][profile["default_model"]]
    providers = [Provider("NVIDIA NIM", NIM_BASE, profile["key"], m["id"], profile.get("rpm", 20.0))]
    or_key = os.environ.get("OPENROUTER_API_KEY")
    if or_key:
        for name, mid in OPENROUTER_FREE_MODELS:
            providers.append(Provider(name, OPENROUTER_BASE, or_key, mid, 18.0))
    return ProviderPool(providers)

# ───────────────────────────────────────────
# CONFIG & SESSIONS
# ───────────────────────────────────────────
def ensure_config() -> Dict:
    c = {}
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                c = json.load(f)
        except Exception:
            pass
    if "profiles" not in c:
        c["profiles"] = {}
    if "next_id" not in c:
        c["next_id"] = 1
    return c


def save_config(c: Dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(c, f, indent=2)


def prompt_first_setup() -> Dict:
    sep("First-Time Setup")
    if HAS_RICH:
        console.print("[label]Create your first profile[/label]")
    else:
        print(f"{C.BOLD}First-Time Setup — Create your first profile{C.RESET}")
    name = input("Profile name (e.g. OMEGA): ").strip() or "OMEGA"
    key = input("NVIDIA API key: ").strip()
    glm = input("GLM model ID [z-ai/glm-5.2]: ").strip() or "z-ai/glm-5.2"
    nem = input("Nemotron ID [nvidia/nemotron-3-ultra-550b-a55b]: ").strip() or "nvidia/nemotron-3-ultra-550b-a55b"
    c = ensure_config()
    pid = str(c["next_id"])
    c["next_id"] += 1
    c["profiles"][pid] = {
        "name": name, "key": key, "default_model": "nemotron", "rpm": 20.0,
        "models": {"glm": {"name": "GLM", "id": glm}, "nemotron": {"name": "Nemotron", "id": nem}}
    }
    save_config(c)
    ok(f"Created profile '{name}'.")
    return c


def load_session(pk: str, pdir: str) -> Optional[Dict]:
    k = f"{pk}::{pdir}"
    if SESSIONS_FILE.exists():
        try:
            with open(SESSIONS_FILE, "r") as f:
                return json.load(f).get(k)
        except Exception:
            pass
    return None


def save_session(pk: str, pdir: str, data: Dict):
    k = f"{pk}::{pdir}"
    s = {}
    if SESSIONS_FILE.exists():
        try:
            with open(SESSIONS_FILE, "r") as f:
                s = json.load(f)
        except Exception:
            pass
    s[k] = data
    with open(SESSIONS_FILE, "w") as f:
        json.dump(s, f)

# ───────────────────────────────────────────
# TOOLS
# ───────────────────────────────────────────
class FileTools:
    def __init__(self, base: str):
        self.base = Path(base).resolve()

    def _safe(self, p: str) -> Path:
        """Resolve a path and enforce it stays within the project base dir.

        BUGFIX: the original implementation resolved the path with no
        containment check at all, meaning a tool call (or a prompt-injected
        instruction hidden inside file content the agent reads) could escape
        the project directory entirely via '../../../etc/whatever' and
        read/write arbitrary files on disk. This raises instead.
        """
        t = (self.base / p).resolve()
        try:
            t.relative_to(self.base)
        except ValueError:
            raise PermissionError(f"Path '{p}' escapes project directory ({self.base})")
        return t

    def read(self, path: str) -> str:
        try:
            t = self._safe(path)
            if not t.exists():
                return f"[ERR] File not found: {path}"
            with open(t, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception as e:
            return f"[ERR] {e}"

    def write(self, path: str, content: str) -> str:
        try:
            t = self._safe(path)
            t.parent.mkdir(parents=True, exist_ok=True)
            with open(t, "w", encoding="utf-8") as f:
                f.write(content)
            return f"[OK] Written {len(content)} chars to {path}"
        except Exception as e:
            return f"[ERR] {e}"

    def search(self, pattern: str, path: str = ".") -> str:
        try:
            t = self._safe(path)
            rx = re.compile(pattern, re.IGNORECASE)
            matches = []
            for root, dirs, files in os.walk(t):
                dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "node_modules")]
                for fn in files:
                    if fn.endswith((".pyc", ".exe", ".dll", ".png", ".jpg", ".zip", ".tar")):
                        continue
                    fp = Path(root) / fn
                    try:
                        with open(fp, "r", encoding="utf-8", errors="replace") as f:
                            for i, line in enumerate(f, 1):
                                if rx.search(line):
                                    matches.append(f"{fp.relative_to(self.base)}:{i} {line.strip()}")
                                    if len(matches) >= 50:
                                        break
                    except Exception:
                        pass
                    if len(matches) >= 50:
                        break
            return "\n".join(matches) if matches else f"No matches for '{pattern}'"
        except Exception as e:
            return f"[ERR] {e}"

    def run_cmd(self, cmd: str) -> str:
        try:
            if HAS_RICH:
                console.print(f"  [accent]▶ Executing Live:[/accent] {esc(cmd)}")
            else:
                print(f"  {C.BCYAN}▶ Executing Live:{C.RESET} {cmd}")
            p = subprocess.Popen(cmd, cwd=self.base, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, shell=True)
            out = []
            for line in p.stdout:
                out.append(line)
                if HAS_RICH:
                    console.print(f"    [muted]│[/muted] {esc(line.rstrip(chr(10)))}")
                else:
                    print(f"    {C.DIM}│{C.RESET} {line}", end="")
            try:
                p.wait(timeout=120)
                exit_note = f"\n[EXIT CODE: {p.returncode}]"
            except subprocess.TimeoutExpired:
                p.kill()
                exit_note = "\n[ERR: command exceeded 120s timeout and was killed]"
            return "".join(out) + exit_note
        except Exception as e:
            return f"[ERR] {e}"


TOOLS_SCHEMA = [
    {"type": "function", "function": {"name": "read_file", "description": "Read file contents.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {"name": "write_file", "description": "Create/overwrite file.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["path", "content"]}}},
    {"type": "function", "function": {"name": "search_files", "description": "Regex search in project.",
     "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "default": "."}},
                    "required": ["pattern"]}}},
    {"type": "function", "function": {"name": "run_command", "description": "Run shell command/tests.",
     "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}}
]


def execute_tool(tools: FileTools, name: str, args: Dict) -> str:
    if name == "read_file":
        return tools.read(args.get("path", ""))
    if name == "write_file":
        return tools.write(args.get("path", ""), args.get("content", ""))
    if name == "search_files":
        return tools.search(args.get("pattern", ""), args.get("path", "."))
    if name == "run_command":
        return tools.run_cmd(args.get("command", ""))
    return f"[ERR] Unknown tool: {name}"

# ───────────────────────────────────────────
# AGENT
# ───────────────────────────────────────────
class NIMAgent:
    def __init__(self, profile: Dict, pdir: str):
        self.profile = profile
        self.pdir = pdir
        self.tools = FileTools(pdir)
        self.pool = build_provider_pool(profile)
        self.messages = []
        self.goal = None
        self.meter = TokenMeter()

        # 10% threshold ensures payload stays light (~12k tokens max) for instant TTFT
        self.compact_threshold = 0.10
        self.compaction_summary = None

        s = load_session(profile["name"], pdir)
        if s:
            try:
                resume = input(f"  Resume saved session? [Y/n]: ").strip().lower()
            except KeyboardInterrupt:
                print()
                resume = "n"
            if resume != 'n':
                self.messages = s.get("messages", [])
                self.goal = s.get("goal")
                self.compaction_summary = s.get("compaction_summary")
                ok("Session restored.")
        self._rebuild_system()

    def _rebuild_system(self):
        p = ["You are an expert autonomous developer.",
             "Use tools proactively to achieve the goal.",
             "Follow TDD. Verify changes by running tests."]
        p.append("CRITICAL: You MUST use the native JSON tool calling API to execute tools. "
                  "NEVER output raw XML, markdown, or text blocks (like <tool_call>) to call tools.")
        if self.goal:
            p.append(f"CURRENT GOAL: {self.goal}")
        p.append(f"Working Directory: {self.pdir}")
        self.messages = [m for m in self.messages if m.get("role") != "system"]
        self.messages.insert(0, {"role": "system", "content": "\n".join(p)})
        if self.compaction_summary:
            if not any(self.compaction_summary in (m.get("content") or "") for m in self.messages):
                self.messages.insert(1, {"role": "user", "content": f"[PRIOR CONTEXT SUMMARY]\n{self.compaction_summary}"})
                self.messages.insert(2, {"role": "assistant", "content": "Context acknowledged. Continuing."})

    def est_tokens(self) -> int:
        return sum(max(1, len(str(m.get("content", ""))) // 4) for m in self.messages)

    def maybe_compact(self):
        ctx_size = self.est_tokens()
        if ctx_size < 128000 * self.compact_threshold:
            return
        sys_msgs = [m for m in self.messages if m.get("role") == "system"]
        rest = [m for m in self.messages if m.get("role") != "system"]
        if len(rest) <= 8:
            return

        old, recent = rest[:-8], rest[-8:]
        lines = []
        for m in old:
            c = str(m.get("content", ""))[:150].replace("\n", " ")
            lines.append(f"- {m.get('role')}: {c}")

        self.compaction_summary = f"Folded {len(old)} messages.\n" + "\n".join(lines[-40:])
        self.messages = sys_msgs + recent
        self._rebuild_system()
        info(f"Context compacted: ~{ctx_size} -> ~{self.est_tokens()} tokens")

    def save(self):
        save_session(self.profile["name"], self.pdir, {
            "messages": self.messages, "goal": self.goal, "compaction_summary": self.compaction_summary
        })

    def _round_header(self, rnd: int, ctx: int):
        if HAS_RICH:
            t = Table.grid(padding=(0, 2))
            t.add_column(justify="left")
            t.add_column(justify="right")
            t.add_row(
                Text.from_markup(f"[label]Round {rnd + 1}[/label][muted]/100[/muted]"),
                Text.from_markup(f"[muted]context ~{ctx} tok[/muted]"),
            )
            console.print(Rule(style="border"))
            console.print(t)
        else:
            sep()
            print(f"{C.BCYAN}{C.BOLD}Round {rnd+1}/100{C.RESET} {C.DIM}| Context: ~{ctx} tokens{C.RESET}")

    def run(self, prompt: str):
        self.messages.append({"role": "user", "content": prompt})

        # Max 100 rounds allows massive projects without stalling.
        # NOTE: `rnd` only advances via the for-loop; retries on transient
        # overload errors use `continue`, which *does* consume a round-loop
        # iteration. We guard against that below by tracking a separate
        # retry budget so flaky connections don't eat the 100-round budget.
        rnd = 0
        retries_this_round = 0
        while rnd < 100:
            self.maybe_compact()
            ctx = self.est_tokens()
            self._round_header(rnd, ctx)

            payload = {
                "messages": [{k: v for k, v in m.items() if not k.startswith('_')} for m in self.messages],
                "max_tokens": 32768,
                "temperature": 0.2,
                "stream": True,
                "tools": TOOLS_SCHEMA,
                "tool_choice": "none" if (rnd > 0 and (rnd + 1) % 15 == 0) else "auto"
            }

            full_content = ""
            full_reason = ""
            tcalls = []
            heartbeat_step = 2048
            last_heartbeat = {}

            provider = None
            overloaded = False
            try:
                for _ in range(5):
                    provider = self.pool.next_available()
                    if not provider:
                        warn(f"All providers cooling down. Waiting {self.pool.wait_time():.1f}s...")
                        time.sleep(self.pool.wait_time())
                        continue

                    with provider.bucket.lock:
                        wt = provider.bucket._wait_time()
                    if wt > 0.5:
                        if HAS_RICH:
                            console.print(f"  [muted]pacing rate limit (~{wt:.1f}s)...[/muted]")
                        else:
                            print(f"  {C.DIM}⏳ Pacing API rate limit (~{wt:.1f}s)...{C.RESET}")
                    if not provider.bucket.reserve(60):
                        self.pool.rotate()
                        continue

                    if HAS_RICH:
                        console.print(f"  [muted]awaiting {esc(provider.name)} (TTFT)...[/muted]", end="\r")
                    else:
                        print(f"  {C.DIM}📡 Awaiting {provider.name} (TTFT)...{C.RESET}", end="\r")

                    if not HAS_OPENAI:
                        err("OpenAI package missing. Run: pip install openai")
                        return

                    payload["model"] = provider.model_id
                    if "glm" in provider.model_id:
                        payload["extra_body"] = {"chat_template_kwargs": {"enable_thinking": True, "thinking_effort": "medium"}}

                    resp = provider.client.chat.completions.create(**payload)
                    in_think = False
                    print(" " * 60, end="\r")

                    for chunk in resp:
                        delta = chunk.choices[0].delta

                        if hasattr(delta, "reasoning_content") and delta.reasoning_content:
                            if not in_think:
                                if HAS_RICH:
                                    console.print("  [think]◆ thinking[/think]")
                                else:
                                    print(f"  {C.BMAGENTA}🧠 Thinking:{C.RESET}")
                                in_think = True
                            if HAS_RICH:
                                console.print(f"[think]{esc(delta.reasoning_content)}[/think]", end="")
                            else:
                                print(f"{C.DIM}{delta.reasoning_content}{C.RESET}", end="", flush=True)
                            full_reason += delta.reasoning_content

                        if delta.content:
                            if in_think:
                                print()
                                in_think = False
                            if HAS_RICH:
                                console.print(f"[assistant]{esc(delta.content)}[/assistant]", end="")
                            else:
                                print(f"{C.BWHITE}{delta.content}{C.RESET}", end="", flush=True)
                            full_content += delta.content

                        if delta.tool_calls:
                            if in_think:
                                print()
                                in_think = False
                            for tc in delta.tool_calls:
                                idx = tc.index
                                while len(tcalls) <= idx:
                                    tcalls.append({"id": "", "name": "", "args": ""})
                                    last_heartbeat[len(tcalls) - 1] = 0
                                if tc.id:
                                    tcalls[idx]["id"] += tc.id
                                if tc.function:
                                    if tc.function.name:
                                        tcalls[idx]["name"] += tc.function.name
                                        if HAS_RICH:
                                            console.print(f"\n  [tool]▸ preparing tool:[/tool] {esc(tcalls[idx]['name'])}...")
                                        else:
                                            print(f"\n  {C.BYELLOW}🛠 Preparing Tool:{C.RESET} {tcalls[idx]['name']}...", flush=True)
                                    if tc.function.arguments:
                                        tcalls[idx]["args"] += tc.function.arguments
                                        # BUGFIX: heartbeat used `% 2048 == 0`, which almost
                                        # never lands exactly since chunks arrive in
                                        # arbitrary sizes — it basically never fired.
                                        # Use a threshold crossing instead.
                                        cur_len = len(tcalls[idx]["args"])
                                        if cur_len - last_heartbeat.get(idx, 0) >= heartbeat_step:
                                            last_heartbeat[idx] = cur_len
                                            if HAS_RICH:
                                                console.print(f"    [muted]… args {cur_len} chars[/muted]")
                                            else:
                                                print(f"    {C.DIM}… args {cur_len} chars{C.RESET}", flush=True)
                    break

                if provider:
                    provider.record_success()

            except KeyboardInterrupt:
                raise
            except Exception as e:
                err_str = str(e).lower().replace(" ", "")
                is_overload = any(x in err_str for x in [
                    "429", "toomanyrequests", "ratelimit", "resourceexhausted",
                    "quota", "workerlocaltotalrequestlimit", "overloaded",
                    "503", "502", "500", "504"
                ])

                if is_overload:
                    print()
                    warn("Server overload — connection dropped mid-stream.")
                    if HAS_RICH:
                        console.print("  [muted]The provider is currently busy. Retrying...[/muted]\n")
                    else:
                        print(f"  {C.DIM}The NVIDIA server is currently busy. Retrying round...{C.RESET}\n", flush=True)
                    if provider:
                        provider.record_rejection()
                    self.pool.rotate()
                    time.sleep(3.0)
                    overloaded = True
                else:
                    print()
                    err(f"API error: {e}")
                    return

            if overloaded:
                # BUGFIX: retries used to `continue` inside the `for rnd in
                # range(100)` loop, silently burning a round of the 100-round
                # budget for a request that never actually completed. We now
                # use a while-loop and only increment `rnd` on real progress,
                # capping retries separately so a flaky connection can't
                # starve the agent of its round budget.
                retries_this_round += 1
                if retries_this_round > 20:
                    err("Too many consecutive overload retries — aborting this turn.")
                    return
                continue
            retries_this_round = 0

            print("\n", flush=True)
            self.meter.record(ctx, len(full_content) // 4)

            # ─── TOOL EXECUTION ───
            if tcalls:
                self.messages.append({
                    "role": "assistant", "content": full_content or None,
                    "tool_calls": [{"id": t["id"], "type": "function",
                                    "function": {"name": t["name"], "arguments": t["args"]}} for t in tcalls]
                })

                for t in tcalls:
                    name = t["name"]
                    try:
                        args = json.loads(t["args"])
                    except Exception:
                        args = {}

                    if HAS_RICH:
                        console.print(f"  [tool]⚙ executing:[/tool] {esc(name)} [muted]{esc(json.dumps(args))}[/muted]")
                    else:
                        print(f"  {C.BYELLOW}⚙ Executing:{C.RESET} {name} {C.DIM}{json.dumps(args)}{C.RESET}")
                    res = execute_tool(self.tools, name, args)

                    if len(res) > 1500:
                        ui_res = res[:1500] + f"\n\n  ... [Terminal preview truncated to keep UI clean. The agent received the full {len(res)} chars.] ..."
                    else:
                        ui_res = res

                    for line in ui_res.split("\n"):
                        if HAS_RICH:
                            console.print(f"    [muted]│[/muted] {esc(line)}")
                        else:
                            print(f"    {C.DIM}│{C.RESET} {line}")

                    # BUGFIX: original truncation math was
                    #   res[:int((128000 - ctx) * 2)]
                    # This assumed 1 token ≈ 0.5 chars, the *inverse* of the
                    # est_tokens() estimator elsewhere (len // 4, i.e. 1 token
                    # ≈ 4 chars) — off by 8x. Worse: if ctx > 128000 the slice
                    # index goes negative, and in Python `s[:-N]` means
                    # "everything except the last N chars" — i.e. it silently
                    # KEPT almost everything instead of truncating, doing the
                    # exact opposite of what was intended. Fixed to use the
                    # matching *4 factor and clamp to a sane non-negative
                    # range with a sensible floor.
                    remaining_tokens = max(2000, 128000 - ctx)
                    max_chars = remaining_tokens * 4
                    safe_res = res[:max_chars]
                    self.messages.append({"role": "tool", "tool_call_id": t["id"], "name": name, "content": safe_res})

                self.save()
                if HAS_RICH:
                    console.print("\n  [muted]pacing before next round (3.0s)...[/muted]")
                else:
                    print(f"\n  {C.DIM}⏳ Inter-round pacing (3.0s)...{C.RESET}")
                time.sleep(3.0)
                rnd += 1
            else:
                self.messages.append({"role": "assistant", "content": full_content})
                self.save()
                break

# ───────────────────────────────────────────
# UI RUNNER
# ───────────────────────────────────────────
def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')


def print_profiles_table(profiles: Dict):
    if HAS_RICH:
        t = Table(box=ROUNDED, border_style="border", show_header=True, header_style="label", expand=False)
        t.add_column("ID", style="muted", width=4)
        t.add_column("Profile", style="accent")
        t.add_column("Model", style="value")
        t.add_column("RPM", style="muted", justify="right")
        for pid, p in profiles.items():
            try:
                model_id = p["models"][p["default_model"]]["id"]
            except KeyError:
                model_id = "[err: default_model missing]"
            t.add_row(pid, p.get("name", "?"), model_id, str(p.get("rpm", 20)))
        console.print(t)
    else:
        print(f"{C.BOLD}Available Profiles:{C.RESET}")
        sep()
        for pid, p in profiles.items():
            try:
                model_id = p["models"][p["default_model"]]["id"]
            except KeyError:
                model_id = "[err: default_model missing]"
            print(f" [{pid}] {C.BCYAN}{p.get('name','?'):<15}{C.RESET} | Model: {model_id:<35} | Limit: {p.get('rpm', 20)} RPM")
        sep()


def main():
    try:
        clear_screen()
        banner()

        cfg = ensure_config()
        if not cfg.get("profiles"):
            cfg = prompt_first_setup()

        profiles = cfg["profiles"]

        if HAS_RICH:
            console.print()
            console.print("[label]Available Profiles[/label]")
        print_profiles_table(profiles)

        choice = input(f"\nSelect profile [{', '.join(profiles.keys())}] [default: 1]: ").strip() or "1"
        if choice not in profiles:
            warn("Invalid choice, using default.")
            choice = list(profiles.keys())[0]

        p = profiles[choice]
        # BUGFIX: defensive access — a hand-edited or corrupted config could
        # have a default_model pointing at a model entry that doesn't exist,
        # which previously threw an uncaught KeyError and killed the whole
        # program before the agent even started.
        if p.get("default_model") not in p.get("models", {}):
            err(f"Profile '{p.get('name','?')}' has an invalid default_model — cannot start.")
            return
    except KeyboardInterrupt:
        print()
        return

    try:
        agent = NIMAgent(p, os.getcwd())
    except KeyboardInterrupt:
        print()
        return

    clear_screen()
    banner(f"{p['name']}  ·  {agent.pool.current().model_id}")
    if HAS_RICH:
        t = Table.grid(padding=(0, 2))
        t.add_column(style="label")
        t.add_column(style="value")
        t.add_row("Project", agent.pdir)
        t.add_row("Limits", f"{p.get('rpm', 20)} RPM ceiling · 32k output runway · 10% lean context")
        console.print(Panel(t, box=ROUNDED, border_style="border", padding=(0, 2)))
        console.print("[muted]Type /goal <text> to set objectives, /clear to reset, /exit to quit.[/muted]\n")
    else:
        sep(C.BMAGENTA if False else "")
        print(f" {C.BOLD}Profile:{C.RESET} {C.BCYAN}{p['name']}{C.RESET} ({agent.pool.current().model_id})")
        print(f" {C.BOLD}Project:{C.RESET} {agent.pdir}")
        print(f" {C.BOLD}Limits: {C.RESET} {p.get('rpm', 20)} RPM Ceiling | 32k Output Runway | 10% Lean Context")
        sep()
        print(f" {C.DIM}Type /goal <text> to set objectives, /clear to reset, /exit to quit.{C.RESET}\n")

    try:
        while True:
            try:
                if HAS_RICH:
                    cmd = console.input("[accent]❯[/accent] ").strip()
                else:
                    cmd = input(f"{C.BCYAN}❯{C.RESET} ").strip()
            except KeyboardInterrupt:
                print()
                break
            if not cmd:
                continue
            if cmd == "/exit":
                break
            if cmd.startswith("/goal "):
                agent.goal = cmd[6:].strip()
                agent._rebuild_system()
                ok(f"Goal set: {agent.goal}")
                continue
            if cmd == "/clear":
                agent.messages = []
                agent._rebuild_system()
                ok("Context cleared.")
                continue

            agent.run(cmd)
    except KeyboardInterrupt:
        if HAS_RICH:
            console.print("\n[muted]Exiting...[/muted]")
        else:
            print(f"\n{C.DIM}Exiting...{C.RESET}")
    finally:
        agent.save()


if __name__ == "__main__":
    main()