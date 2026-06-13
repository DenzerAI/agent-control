from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = PROJECT_ROOT / "config" / "restart-policy.json"

DEFAULT_POLICY = {
    "blocked": True,
    "reason": "Restart nur nach ausdrücklicher Freigabe durch Christian.",
    "grant_until": 0,
    "grant_reason": "",
    "updated_at": 0,
    "updated_by": "system",
}


class RestartBlockedError(RuntimeError):
    pass


def load_policy() -> dict:
    policy = dict(DEFAULT_POLICY)
    try:
        raw = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            policy.update(raw)
    except FileNotFoundError:
        pass
    except Exception:
        pass
    policy["blocked"] = bool(policy.get("blocked", True))
    policy["reason"] = str(policy.get("reason") or DEFAULT_POLICY["reason"])
    policy["grant_until"] = int(policy.get("grant_until") or 0)
    policy["grant_reason"] = str(policy.get("grant_reason") or "")
    policy["updated_at"] = int(policy.get("updated_at") or 0)
    policy["updated_by"] = str(policy.get("updated_by") or "system")
    return policy


def save_policy(policy: dict) -> dict:
    clean = {
        "blocked": bool(policy.get("blocked", True)),
        "reason": str(policy.get("reason") or DEFAULT_POLICY["reason"]),
        "grant_until": int(policy.get("grant_until") or 0),
        "grant_reason": str(policy.get("grant_reason") or ""),
        "updated_at": int(policy.get("updated_at") or time.time()),
        "updated_by": str(policy.get("updated_by") or "system"),
    }
    POLICY_PATH.parent.mkdir(parents=True, exist_ok=True)
    POLICY_PATH.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return clean


def is_restart_allowed(now: int | None = None) -> tuple[bool, dict]:
    policy = load_policy()
    ts = int(now or time.time())
    if not policy["blocked"]:
        return True, policy
    if policy["grant_until"] > ts:
        return True, policy
    return False, policy


def describe_policy(policy: dict | None = None, now: int | None = None) -> str:
    policy = policy or load_policy()
    ts = int(now or time.time())
    if not policy["blocked"]:
        return "Restart freigegeben ohne Sperre."
    if policy["grant_until"] > ts:
        remaining = policy["grant_until"] - ts
        reason = policy["grant_reason"] or policy["reason"]
        return f"Restart vorübergehend freigegeben für {remaining}s. Grund: {reason}"
    return f"Restart gesperrt. Grund: {policy['reason']}"


def status_payload(now: int | None = None) -> dict:
    ts = int(now or time.time())
    allowed, policy = is_restart_allowed(ts)
    return {
        "blocked": bool(policy["blocked"]),
        "allowed_now": allowed,
        "grant_until": int(policy["grant_until"]),
        "grant_active": bool(policy["grant_until"] > ts),
        "reason": policy["reason"],
        "grant_reason": policy["grant_reason"],
        "updated_at": int(policy["updated_at"]),
        "updated_by": policy["updated_by"],
        "message": describe_policy(policy, ts),
    }


def assert_restart_allowed(source: str, now: int | None = None) -> dict:
    ts = int(now or time.time())
    allowed, policy = is_restart_allowed(ts)
    if allowed:
        return status_payload(ts)
    raise RestartBlockedError(
        f"Restart blockiert für {source}. {describe_policy(policy, ts)} "
        f"Freigabe bei Bedarf mit scripts/restart-control.sh erlauben."
    )


def block_restarts(reason: str, actor: str) -> dict:
    policy = load_policy()
    policy.update({
        "blocked": True,
        "reason": reason or DEFAULT_POLICY["reason"],
        "grant_until": 0,
        "grant_reason": "",
        "updated_at": int(time.time()),
        "updated_by": actor,
    })
    save_policy(policy)
    return status_payload()


def allow_restarts(minutes: int, reason: str, actor: str) -> dict:
    now = int(time.time())
    policy = load_policy()
    policy.update({
        "blocked": True,
        "grant_until": now + max(1, minutes) * 60,
        "grant_reason": reason,
        "updated_at": now,
        "updated_by": actor,
    })
    save_policy(policy)
    return status_payload(now)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Restart-Policy für Agent Control")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status")

    assert_p = sub.add_parser("assert")
    assert_p.add_argument("--source", default="unknown")

    block_p = sub.add_parser("block")
    block_p.add_argument("--reason", default=DEFAULT_POLICY["reason"])
    block_p.add_argument("--actor", default="manual")

    allow_p = sub.add_parser("allow")
    allow_p.add_argument("--minutes", type=int, default=10)
    allow_p.add_argument("--reason", default="Temporäre Restart-Freigabe")
    allow_p.add_argument("--actor", default="manual")

    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if args.cmd == "status":
        print(json.dumps(status_payload(), ensure_ascii=False))
        return 0

    if args.cmd == "assert":
        try:
            print(json.dumps(assert_restart_allowed(args.source), ensure_ascii=False))
            return 0
        except RestartBlockedError as exc:
            print(str(exc))
            return 3

    if args.cmd == "block":
        print(json.dumps(block_restarts(args.reason, args.actor), ensure_ascii=False))
        return 0

    if args.cmd == "allow":
        print(json.dumps(allow_restarts(args.minutes, args.reason, args.actor), ensure_ascii=False))
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
