#!/usr/bin/env python3
"""Read-only check of identity inherited by the agent's actual shell tool.

Run from exec_command in the resumed agent. Expected arguments are comparisons;
this program never changes environment variables, sessions or terminal bindings.
"""
import argparse
import json
import os
from pathlib import Path


def check_binding(actual, expected):
    failures = []
    for key in ("CODEX_THREAD_ID", "CODEX_SESSION_ID"):
        if actual.get(key) != expected["session"]:
            failures.append(key)
    if actual.get("ORCA_TERMINAL_HANDLE") != expected["handle"]:
        failures.append("ORCA_TERMINAL_HANDLE")
    if actual.get("workspace") != expected["workspace"]:
        failures.append("workspace")
    return {"ok": not failures, "mismatches": failures, "actual": actual,
            "expected": expected}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True)
    parser.add_argument("--handle", required=True)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    actual = {key: os.environ.get(key) for key in
              ("CODEX_THREAD_ID", "CODEX_SESSION_ID", "ORCA_TERMINAL_HANDLE")}
    actual["workspace"] = str(Path.cwd().resolve())
    expected = {"session": args.session, "handle": args.handle,
                "workspace": str(Path(args.workspace).resolve(strict=True))}
    report = check_binding(actual, expected)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
