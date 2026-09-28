"""Regression run: the 12 recorded demo chat questions against a local API.

Posts each question from ``apps/web/demo/fixtures/chat/index.json`` to
``POST <base>/api/agent/query`` and reports tool-call / sources counts. A row
PASSes when ``tool_calls > 0 and sources > 0``; an errored row is a FAIL.
Exit code 0 when every row passes, 1 otherwise, 2 for setup errors.

Usage (run from ``apps/api``)::

    # against an already-running API
    ~/.venvs/compendium/bin/python3 scripts/agent_regression.py \\
        --base-url http://127.0.0.1:8012 --label baseline --out /tmp/run.json

    # spawn a throwaway uvicorn (DEV_AUTH_BYPASS) on --port, then stop it
    ~/.venvs/compendium/bin/python3 scripts/agent_regression.py \\
        --spawn --port 8012 --prompt-version <version> --label candidate

Options: --fixtures PATH, --token TOKEN (or env AGENT_REGRESSION_TOKEN),
--pace-seconds N (default 7; keeps 12 calls under the endpoint's 10/minute
limit), --user-email EMAIL (spawn only, default demo@traversal.local).
--spawn refuses ports 3000, 8001, 8765 and cannot be combined with --base-url.
The script never prints environment values and never reads ``.env`` itself.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import httpx

DEFAULT_FIXTURES = (
    PROJECT_ROOT.parent / "web" / "demo" / "fixtures" / "chat" / "index.json"
)
RESERVED_PORTS = (3000, 8001, 8765)
TIMEOUT_S = 120.0


def load_questions(path: Path) -> list[dict]:
    return json.loads(Path(path).read_text())


def first_sentence(text: str) -> str:
    text = " ".join((text or "").split())
    m = re.match(r"(.+?[.!?])(\s|$)", text)
    return (m.group(1) if m else text)[:160]


def build_row(n: str, data: dict | None, latency: float, error: str | None) -> dict:
    if data is None:
        return {
            "n": n, "tool_calls": 0, "tools": [], "sources": 0,
            "first_sentence": "", "answer_chars": 0, "cost_usd": None,
            "latency_s": round(latency, 1), "answer": "", "error": error,
        }
    answer = data.get("answer") or ""
    tools = [t.get("tool") for t in data.get("tool_calls_made") or []]
    return {
        "n": n,
        "tool_calls": len(tools),
        "tools": tools,
        "sources": len(data.get("sources") or []),
        "first_sentence": first_sentence(answer),
        "answer_chars": len(answer),
        "cost_usd": data.get("total_cost_usd"),
        "latency_s": round(latency, 1),
        "answer": answer,
        "error": error,
    }


def verdict(row: dict) -> str:
    if row.get("error"):
        return "FAIL"
    return "PASS" if row.get("tool_calls", 0) > 0 and row.get("sources", 0) > 0 else "FAIL"


def _call(client: httpx.Client, base: str, question: str, token: str | None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t0 = time.perf_counter()
    try:
        resp = client.post(
            f"{base}/api/agent/query", json={"query": question},
            headers=headers, timeout=TIMEOUT_S,
        )
    except httpx.TransportError as e:
        return None, time.perf_counter() - t0, f"{type(e).__name__}: {e}", True
    dt = time.perf_counter() - t0
    if resp.status_code >= 400:
        return None, dt, f"HTTP {resp.status_code}: {resp.text[:200]}", False
    try:
        data = resp.json()
    except ValueError as e:
        return None, dt, f"bad JSON: {e}", False
    required = ("answer", "sources", "tool_calls_made")
    if not isinstance(data, dict):
        return None, dt, f"malformed response: missing {', '.join(required)}", False
    missing = [k for k in required if k not in data]
    if missing:
        return None, dt, f"malformed response: missing {', '.join(missing)}", False
    return data, dt, None, False


def run_question(client, base, n, question, token) -> dict:
    data, dt, err, transport = _call(client, base, question, token)
    if transport:
        print(f"  {n} transport error ({err}); one re-run", flush=True)
        time.sleep(5)
        data, dt, err, _ = _call(client, base, question, token)
    return build_row(n, data, dt, err)


def _print_row(row: dict) -> None:
    if row["error"]:
        print(f"  {row['n']} FAIL {row['error']} ({row['latency_s']}s)", flush=True)
        return
    print(
        f"  {row['n']} {verdict(row)} tools={row['tool_calls']} "
        f"sources={row['sources']} {row['latency_s']}s :: "
        f"{row['first_sentence'][:90]}",
        flush=True,
    )


def run_all(client, base, questions, token, pace) -> list[dict]:
    rows = []
    for i, q in enumerate(questions):
        row = run_question(client, base, q["n"], q["question"], token)
        rows.append(row)
        _print_row(row)
        if i < len(questions) - 1:
            time.sleep(pace)
    return rows


def _make_client() -> httpx.Client:
    return httpx.Client()


def build_child_env(port: int, user_email: str, prompt_version: str | None) -> dict:
    env = dict(os.environ)
    env["DEV_AUTH_BYPASS"] = "1"
    env["DEV_DEFAULT_USER_EMAIL"] = user_email
    env["API_PORT"] = str(port)
    if prompt_version:
        env["AGENT_SYSTEM_PROMPT_VERSION"] = prompt_version
    return env


def _wait_ready(base: str, proc, timeout: float = 60) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        code = proc.poll()
        if code is not None:
            print(f"error: server exited early with code {code}", file=sys.stderr)
            return False
        try:
            if httpx.get(f"{base}/docs", timeout=3).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(1)
    return False


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) != 0


def _stop(proc) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _table(rows: list[dict]) -> None:
    print(f"{'n':>3} {'verdict':7} {'tools':>5} {'src':>4} {'lat_s':>6}  tools_used")
    for r in rows:
        print(
            f"{r['n']:>3} {verdict(r):7} {r['tool_calls']:>5} {r['sources']:>4} "
            f"{r['latency_s']:>6}  {','.join(t or '?' for t in r['tools'])}"
        )


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Run demo chat questions against the API.")
    p.add_argument("--base-url")
    p.add_argument("--fixtures", default=str(DEFAULT_FIXTURES))
    p.add_argument("--token", default=os.environ.get("AGENT_REGRESSION_TOKEN"))
    p.add_argument("--pace-seconds", type=float, default=7.0)
    p.add_argument("--label", default="run")
    p.add_argument("--out")
    p.add_argument("--spawn", action="store_true")
    p.add_argument("--port", type=int, default=8012)
    p.add_argument("--user-email", default="demo@traversal.local")
    p.add_argument("--prompt-version")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.spawn and args.base_url:
        print("error: --spawn cannot be combined with --base-url", file=sys.stderr)
        return 2
    if args.spawn and args.port in RESERVED_PORTS:
        print(f"error: refusing reserved port {args.port}", file=sys.stderr)
        return 2
    if not args.spawn and not args.base_url:
        print("error: give --base-url or --spawn", file=sys.stderr)
        return 2

    questions = load_questions(Path(args.fixtures))
    proc = None
    base = args.base_url
    if args.spawn:
        if not _port_free(args.port):
            print(f"error: port {args.port} is already in use", file=sys.stderr)
            return 2
        base = f"http://127.0.0.1:{args.port}"
        cmd = [sys.executable, "-m", "uvicorn", "backend.api.main:app",
               "--host", "127.0.0.1", "--port", str(args.port)]
        env = build_child_env(args.port, args.user_email, args.prompt_version)
        print(f"[{args.label}] spawning uvicorn on port {args.port}", flush=True)
        proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), env=env)
    base = base.rstrip("/")

    try:
        if proc is not None and not _wait_ready(base, proc):
            print("error: server not ready within 60s", file=sys.stderr)
            return 2
        started = datetime.now(UTC).isoformat()
        print(f"[{args.label}] start: {len(questions)} questions against {base}",
              flush=True)
        with _make_client() as client:
            rows = run_all(client, base, questions, args.token, args.pace_seconds)
        passed = sum(1 for r in rows if verdict(r) == "PASS")
        failed = len(rows) - passed
        if args.out:
            Path(args.out).write_text(json.dumps({
                "label": args.label, "base_url": base, "started_at": started,
                "rows": rows, "passed": passed, "failed": failed,
            }, indent=1))
        _table(rows)
        print(f"[{args.label}] done: {passed}/{len(rows)} PASS", flush=True)
        return 0 if failed == 0 else 1
    finally:
        if proc is not None:
            _stop(proc)
            print(f"port {args.port} free again: {_port_free(args.port)}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
