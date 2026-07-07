#!/usr/bin/env python3
"""Detect installed Agent Control CLI engines and optionally persist the result."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from engines.discovery import ENGINE_PRIORITY, RUNTIME_CONFIG_PATH, runtime_manifest, write_runtime_manifest  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write config/engine-runtime.json")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    manifest = write_runtime_manifest() if args.write else runtime_manifest()
    engines = manifest.get("engines") or {}

    if not args.quiet:
        if engines:
            print("Detected engines:")
            for engine in ENGINE_PRIORITY:
                item = engines.get(engine)
                if item:
                    print(f"  {engine}: {item.get('path')}")
        else:
            print("No CLI engines found yet (claude/codex/hermes).")
        if args.write:
            print(f"Wrote {RUNTIME_CONFIG_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
