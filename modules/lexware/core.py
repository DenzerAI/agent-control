"""Lexware-Schublade: Routen fuer Kontakte, Rechnungen, Finance-Overview, Beleg-Upload.

Vorher: 391 Zeilen im `backend/server.py` (Block 7502-7892).
Jetzt: in einer Datei isoliert. Der API-Client (lexoffice.io) lebt unter
`providers/lexoffice.py` -- spaeter koennen weitere Provider (z.B. sevDesk)
gleichberechtigt dazukommen.

Cross-Deps zu server.py:
- `mail` wird lazy importiert (eine Stelle: `finance_inbox_to_lexware`).
- Pfade gehen ueber Repo-Root = parent.parent.parent.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

from .providers import lexoffice as _lex

PROJECT_ROOT = Path(__file__).parent.parent.parent

router = APIRouter()


# ── Lexware Office: Kontakte und Rechnungen ──


@router.get("/api/lexware/contacts")
async def lexware_contacts(q: str = "", size: int = 20):
    if not q.strip():
        return {"contacts": []}
    try:
        items = await _lex.search_contacts(q.strip(), size=size)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    out = []
    for c in items:
        comp = (c.get("company") or {}).get("name")
        per = c.get("person") or {}
        per_name = " ".join(filter(None, [per.get("firstName"), per.get("lastName")])).strip()
        addr = ((c.get("addresses") or {}).get("billing") or [{}])[0]
        out.append({
            "id": c["id"],
            "name": comp or per_name or "(ohne Name)",
            "isCompany": bool(comp),
            "address": f"{addr.get('zip','')} {addr.get('city','')}".strip(),
        })
    return {"contacts": out}


@router.post("/api/lexware/invoices")
async def lexware_create_invoice(req: Request):
    body = await req.json()
    contact_id = (body or {}).get("contactId")
    items = (body or {}).get("lineItems") or []
    if not contact_id or not items:
        return JSONResponse({"error": "contactId und lineItems noetig"}, status_code=400)
    finalize = bool(body.get("finalize", False))
    line_items = [
        _lex.build_line_item(
            name=i["name"],
            quantity=float(i.get("quantity", 1)),
            unit_price=float(i["unitPrice"]),
            unit_name=i.get("unitName", "Stück"),
            description=i.get("description", ""),
        )
        for i in items
    ]
    try:
        inv = await _lex.create_invoice(
            contact_id,
            line_items,
            finalize=finalize,
            intro=body.get("introduction", ""),
            remark=body.get("remark", ""),
            title=body.get("title", "Rechnung"),
        )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return inv


@router.get("/api/lexware/invoices/{invoice_id}/pdf")
async def lexware_invoice_pdf(invoice_id: str):
    try:
        file_id = await _lex.render_pdf(invoice_id)
        pdf = await _lex.download_file(file_id)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return StreamingResponse(
        iter([pdf]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"inline; filename=Rechnung-{invoice_id}.pdf"},
    )


# ── Finance: Live-View aus Lexware Office (Single Source of Truth) ──

_FINANCE_CACHE: dict[str, Any] = {"ts": 0, "data": None}
_FINANCE_TTL = 90  # Sekunden


def _parse_lex_date(s: str) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d")
        except Exception:
            return None


async def _finance_load(force: bool = False) -> dict:
    now = time.time()
    if not force and _FINANCE_CACHE["data"] and (now - _FINANCE_CACHE["ts"]) < _FINANCE_TTL:
        return _FINANCE_CACHE["data"]
    invoices = await _lex.list_invoices_all(size=250)
    try:
        vouchers = await _lex.list_vouchers(voucher_type="purchaseinvoice", size=250)
    except Exception:
        vouchers = []
    data = {"invoices": invoices, "vouchers": vouchers, "fetchedAt": datetime.now(timezone.utc).isoformat()}
    _FINANCE_CACHE["ts"] = now
    _FINANCE_CACHE["data"] = data
    return data


def _finance_summarize(invoices: list[dict], vouchers: list[dict]) -> dict:
    """Aggregiert Monat & YTD."""
    today = datetime.now(ZoneInfo("Europe/Berlin")).date()
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)

    inc_month = inc_ytd = exp_month = exp_ytd = 0.0
    monthly: dict[str, dict[str, float]] = defaultdict(lambda: {"income": 0.0, "expenses": 0.0})
    first_date = None
    last_date = None
    open_count = 0
    open_sum = 0.0
    overdue_count = 0
    for inv in invoices:
        amt = float(inv.get("totalAmount") or 0)
        st = inv.get("voucherStatus") or ""
        d = _parse_lex_date(inv.get("voucherDate") or "")
        if st == "paid" and d:
            key = d.date().strftime("%Y-%m")
            monthly[key]["income"] += amt
            first_date = d.date() if first_date is None else min(first_date, d.date())
            last_date = d.date() if last_date is None else max(last_date, d.date())
            if d.date() >= year_start:
                inc_ytd += amt
            if d.date() >= month_start:
                inc_month += amt
        if st == "open":
            open_count += 1
            open_sum += float(inv.get("openAmount") or amt)
            due = _parse_lex_date(inv.get("dueDate") or "")
            if due and due.date() < today:
                overdue_count += 1
    for v in vouchers:
        amt = float(v.get("totalAmount") or 0)
        d = _parse_lex_date(v.get("voucherDate") or "")
        if d:
            key = d.date().strftime("%Y-%m")
            monthly[key]["expenses"] += amt
            first_date = d.date() if first_date is None else min(first_date, d.date())
            last_date = d.date() if last_date is None else max(last_date, d.date())
            if d.date() >= year_start:
                exp_ytd += amt
            if d.date() >= month_start:
                exp_month += amt

    monthly_rows = []
    for key in sorted(monthly):
        d = datetime.strptime(key, "%Y-%m").date()
        income = round(monthly[key]["income"], 2)
        expenses = round(monthly[key]["expenses"], 2)
        monthly_rows.append({
            "month": key,
            "label": d.strftime("%b %Y"),
            "income": income,
            "expenses": expenses,
            "balance": round(income - expenses, 2),
        })
    all_income = round(sum(m["income"] for m in monthly_rows), 2)
    all_expenses = round(sum(m["expenses"] for m in monthly_rows), 2)

    return {
        "month": {
            "label": today.strftime("%B %Y"),
            "income": round(inc_month, 2),
            "expenses": round(exp_month, 2),
            "balance": round(inc_month - exp_month, 2),
        },
        "ytd": {
            "label": f"YTD {today.year}",
            "income": round(inc_ytd, 2),
            "expenses": round(exp_ytd, 2),
            "balance": round(inc_ytd - exp_ytd, 2),
        },
        "open": {
            "count": open_count,
            "sum": round(open_sum, 2),
            "overdue": overdue_count,
        },
        "history": {
            "firstDate": first_date.isoformat() if first_date else "",
            "lastDate": last_date.isoformat() if last_date else "",
            "months": len(monthly_rows),
            "income": all_income,
            "expenses": all_expenses,
            "balance": round(all_income - all_expenses, 2),
            "monthly": monthly_rows,
        },
    }


def _finance_strip_invoice(inv: dict) -> dict:
    return {
        "id": inv.get("id"),
        "number": inv.get("voucherNumber") or "",
        "date": (inv.get("voucherDate") or "")[:10],
        "dueDate": (inv.get("dueDate") or "")[:10],
        "contact": inv.get("contactName") or "",
        "total": float(inv.get("totalAmount") or 0),
        "open": float(inv.get("openAmount") or 0),
        "currency": inv.get("currency") or "EUR",
        "status": inv.get("voucherStatus") or "",
    }


def _finance_strip_voucher(v: dict) -> dict:
    return {
        "id": v.get("id"),
        "number": v.get("voucherNumber") or "",
        "date": (v.get("voucherDate") or "")[:10],
        "contact": v.get("contactName") or "",
        "total": float(v.get("totalAmount") or 0),
        "currency": v.get("currency") or "EUR",
        "status": v.get("voucherStatus") or "",
        "type": v.get("voucherType") or "",
    }


@router.get("/api/finance/overview")
async def finance_overview(refresh: int = 0):
    try:
        data = await _finance_load(force=bool(refresh))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    invoices = data["invoices"]
    vouchers = data["vouchers"]
    summary = _finance_summarize(invoices, vouchers)
    open_invoices = [_finance_strip_invoice(i) for i in invoices if (i.get("voucherStatus") == "open")]
    open_invoices.sort(key=lambda x: x["dueDate"] or x["date"])
    return {
        **summary,
        "openInvoices": open_invoices[:20],
        "fetchedAt": data["fetchedAt"],
    }


@router.get("/api/finance/invoices")
async def finance_invoices(status: str = "any", limit: int = 100):
    try:
        data = await _finance_load()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    rows = [_finance_strip_invoice(i) for i in data["invoices"]
            if (status == "any" or i.get("voucherStatus") == status)]
    rows.sort(key=lambda x: x["date"], reverse=True)
    return {"invoices": rows[:limit]}


@router.get("/api/finance/expenses")
async def finance_expenses(limit: int = 100):
    try:
        data = await _finance_load()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=502)
    rows = [_finance_strip_voucher(v) for v in data["vouchers"]]
    rows.sort(key=lambda x: x["date"], reverse=True)
    return {"expenses": rows[:limit]}


# ── Finance-Inbox: Mail-Scan-Treffer aus scripts/finance-scan.py ──

FINANCE_INBOX_PATH = PROJECT_ROOT / "data" / "finance-inbox.json"
FINANCE_IGNORED_PATH = PROJECT_ROOT / "data" / "finance-inbox-ignored.json"
FINANCE_SCAN_SCRIPT = PROJECT_ROOT / "scripts" / "finance-scan.py"


def _finance_inbox_read() -> dict:
    if not FINANCE_INBOX_PATH.exists():
        return {"items": [], "count": 0, "fetchedAt": None}
    try:
        return json.loads(FINANCE_INBOX_PATH.read_text())
    except Exception:
        return {"items": [], "count": 0, "fetchedAt": None}


@router.get("/api/finance/inbox")
async def finance_inbox():
    return _finance_inbox_read()


# ── Offene Belege: Mail-Snapshots ohne hochladbares PDF ──

FINANCE_MISSING_PATH = PROJECT_ROOT / "data" / "finance" / "missing-receipts.json"
FINANCE_TAX_COCKPIT_PATH = PROJECT_ROOT / "data" / "finance" / "steuer-cockpit.md"
_STRIPE_CACHE: dict[str, Any] = {"ts": 0, "data": None}
_STRIPE_TTL = 120
_STRIPE_API = "https://api.stripe.com/v1"


@router.get("/api/finance/missing-receipts")
async def finance_missing_receipts():
    if not FINANCE_MISSING_PATH.exists():
        return {"items": [], "by_vendor": [], "total_eur": 0, "count": 0, "unknown_count": 0, "generatedAt": None}
    try:
        return json.loads(FINANCE_MISSING_PATH.read_text())
    except Exception:
        return {"items": [], "by_vendor": [], "total_eur": 0, "count": 0, "unknown_count": 0, "generatedAt": None}


@router.get("/api/finance/tax-cockpit")
async def finance_tax_cockpit():
    if not FINANCE_TAX_COCKPIT_PATH.exists():
        return JSONResponse({"error": "steuer-cockpit fehlt"}, status_code=404)
    try:
        stat = FINANCE_TAX_COCKPIT_PATH.stat()
        return {
            "path": str(FINANCE_TAX_COCKPIT_PATH.relative_to(PROJECT_ROOT)),
            "content": FINANCE_TAX_COCKPIT_PATH.read_text(encoding="utf-8"),
            "updatedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        }
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


def _stripe_secret_key() -> str:
    return (os.getenv("STRIPE_SECRET_KEY") or os.getenv("STRIPE_API_KEY") or "").strip()


def _stripe_period(label: str) -> dict:
    return {
        "label": label,
        "incomeGross": 0.0,
        "fees": 0.0,
        "net": 0.0,
        "refunds": 0.0,
        "payouts": 0.0,
        "count": 0,
    }


def _stripe_eur(cents: int | float | None) -> float:
    return round(float(cents or 0) / 100, 2)


def _stripe_dt(ts: int | float | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc)
    except Exception:
        return None


def _stripe_add(period: dict, tx: dict) -> None:
    amount = _stripe_eur(tx.get("amount"))
    fee = _stripe_eur(tx.get("fee"))
    net = _stripe_eur(tx.get("net"))
    kind = tx.get("type") or ""

    if kind == "payout":
        period["payouts"] = round(period["payouts"] + abs(amount), 2)
        return
    if kind == "stripe_fee":
        period["fees"] = round(period["fees"] + abs(amount), 2)
        period["net"] = round(period["net"] + net, 2)
        return
    if amount >= 0:
        period["incomeGross"] = round(period["incomeGross"] + amount, 2)
        period["fees"] = round(period["fees"] + max(fee, 0), 2)
        period["count"] += 1
    else:
        period["refunds"] = round(period["refunds"] + abs(amount), 2)
    period["net"] = round(period["net"] + net, 2)


def _stripe_row(tx: dict) -> dict:
    created = _stripe_dt(tx.get("created"))
    return {
        "id": tx.get("id") or "",
        "date": created.date().isoformat() if created else "",
        "type": tx.get("type") or "",
        "description": tx.get("description") or "",
        "amount": _stripe_eur(tx.get("amount")),
        "fee": _stripe_eur(tx.get("fee")),
        "net": _stripe_eur(tx.get("net")),
        "currency": (tx.get("currency") or "eur").upper(),
    }


async def _stripe_balance_transactions(year_start_ts: int) -> list[dict]:
    key = _stripe_secret_key()
    rows: list[dict] = []
    starting_after = ""
    async with httpx.AsyncClient(timeout=16) as client:
        for _ in range(5):
            params: dict[str, str] = {"limit": "100", "created[gte]": str(year_start_ts)}
            if starting_after:
                params["starting_after"] = starting_after
            res = await client.get(f"{_STRIPE_API}/balance_transactions", params=params, auth=(key, ""))
            res.raise_for_status()
            payload = res.json()
            data = payload.get("data") or []
            rows.extend([x for x in data if isinstance(x, dict)])
            if not payload.get("has_more") or not data:
                break
            starting_after = str(data[-1].get("id") or "")
            if not starting_after:
                break
    return rows


async def _stripe_summary(force: bool = False) -> dict:
    key = _stripe_secret_key()
    if not key:
        return {"configured": False, "mode": "missing_key", "fetchedAt": None}

    now = time.time()
    if not force and _STRIPE_CACHE["data"] and (now - _STRIPE_CACHE["ts"]) < _STRIPE_TTL:
        return _STRIPE_CACHE["data"]

    today = datetime.now(ZoneInfo("Europe/Berlin")).date()
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)
    year_start_dt = datetime(year_start.year, year_start.month, year_start.day, tzinfo=ZoneInfo("Europe/Berlin"))
    year_start_ts = int(year_start_dt.timestamp())

    txs = await _stripe_balance_transactions(year_start_ts)
    month = _stripe_period(today.strftime("%B %Y"))
    ytd = _stripe_period(f"YTD {today.year}")
    recent: list[dict] = []

    for tx in txs:
        created = _stripe_dt(tx.get("created"))
        if not created:
            continue
        local_date = created.astimezone(ZoneInfo("Europe/Berlin")).date()
        _stripe_add(ytd, tx)
        if local_date >= month_start:
            _stripe_add(month, tx)
        if (tx.get("type") or "") != "payout" and len(recent) < 12:
            recent.append(_stripe_row(tx))

    data = {
        "configured": True,
        "mode": "balance_transactions",
        "month": month,
        "ytd": ytd,
        "recent": recent,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }
    _STRIPE_CACHE["ts"] = now
    _STRIPE_CACHE["data"] = data
    return data


@router.get("/api/finance/stripe")
async def finance_stripe(refresh: int = 0):
    try:
        return await _stripe_summary(force=bool(refresh))
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response else 502
        msg = "Stripe nicht erreichbar"
        try:
            msg = (e.response.json().get("error") or {}).get("message") or msg
        except Exception:
            pass
        return JSONResponse({"configured": True, "error": msg}, status_code=status)
    except Exception as e:
        return JSONResponse({"configured": bool(_stripe_secret_key()), "error": str(e)}, status_code=502)


@router.post("/api/finance/missing-receipts/refresh")
async def finance_missing_receipts_refresh():
    """Triggert scripts/missing-receipts.py und liefert das frische JSON zurueck."""
    proc = subprocess.run(
        ["/Users/klaus/agent/.venv/bin/python", str(PROJECT_ROOT / "scripts" / "missing-receipts.py")],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        return JSONResponse({"error": proc.stderr or proc.stdout}, status_code=500)
    return await finance_missing_receipts()


@router.post("/api/finance/inbox/dismiss")
async def finance_inbox_dismiss(req: Request):
    body = await req.json()
    key = (body or {}).get("key", "")
    if not key:
        return JSONResponse({"error": "key fehlt"}, status_code=400)
    try:
        ignored = set()
        if FINANCE_IGNORED_PATH.exists():
            ignored = set(json.loads(FINANCE_IGNORED_PATH.read_text()).get("keys", []))
        ignored.add(key)
        FINANCE_IGNORED_PATH.write_text(json.dumps({"keys": sorted(ignored)}, indent=2, ensure_ascii=False))
        cur = _finance_inbox_read()
        items = [i for i in cur.get("items", []) if i.get("key") != key]
        FINANCE_INBOX_PATH.write_text(json.dumps({
            "fetchedAt": cur.get("fetchedAt"),
            "count": len(items),
            "items": items,
        }, indent=2, ensure_ascii=False))
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"ok": True}


@router.post("/api/finance/inbox/to-lexware")
async def finance_inbox_to_lexware(req: Request):
    """Holt Anhaenge aus der Inbox-Mail und laedt sie in den Lexware-Belegspeicher.
    Inbox-Eintrag wird danach dismissiert. Mail bleibt unangetastet."""
    body = await req.json()
    key = (body or {}).get("key", "")
    if not key:
        return JSONResponse({"error": "key fehlt"}, status_code=400)

    cur = _finance_inbox_read()
    item = next((i for i in cur.get("items", []) if i.get("key") == key), None)
    if not item:
        return JSONResponse({"error": "Eintrag nicht gefunden"}, status_code=404)

    account = item.get("account") or "owner-account"
    uid = item.get("uid") or ""
    if not uid:
        return JSONResponse({"error": "Mail-UID fehlt"}, status_code=400)

    try:
        import mail as _mail
        msg_data = await asyncio.to_thread(_mail.fetch_message, account, uid)
    except Exception as e:
        return JSONResponse({"error": f"Mail laden: {e}"}, status_code=500)

    attachments = msg_data.get("attachments") or []
    pdf_atts = [a for a in attachments if (a.get("content_type") or "").lower() in (
        "application/pdf", "application/octet-stream"
    ) or (a.get("filename") or "").lower().endswith(".pdf")]
    if not pdf_atts:
        return JSONResponse({"error": "Keine PDF-Anhaenge in dieser Mail."}, status_code=422)

    uploaded: list[str] = []
    errors: list[str] = []
    for att in pdf_atts:
        try:
            import mail as _mail
            blob = await asyncio.to_thread(_mail.fetch_attachment, account, uid, int(att["index"]))
            res = await _lex.upload_voucher_file(
                blob["filename"], blob["data"],
                blob.get("content_type") or "application/pdf",
            )
            uploaded.append(res.get("id") or att["filename"])
        except Exception as e:
            errors.append(f"{att.get('filename')}: {e}")

    if not uploaded:
        return JSONResponse({"error": "; ".join(errors) or "Upload fehlgeschlagen"}, status_code=500)

    try:
        ignored = set()
        if FINANCE_IGNORED_PATH.exists():
            ignored = set(json.loads(FINANCE_IGNORED_PATH.read_text()).get("keys", []))
        ignored.add(key)
        FINANCE_IGNORED_PATH.write_text(json.dumps({"keys": sorted(ignored)}, indent=2, ensure_ascii=False))
        items = [i for i in cur.get("items", []) if i.get("key") != key]
        FINANCE_INBOX_PATH.write_text(json.dumps({
            "fetchedAt": cur.get("fetchedAt"),
            "count": len(items),
            "items": items,
        }, indent=2, ensure_ascii=False))
    except Exception:
        pass

    _FINANCE_CACHE["ts"] = 0
    return {"ok": True, "uploaded": uploaded, "errors": errors}


@router.post("/api/finance/inbox/scan")
async def finance_inbox_scan():
    if not FINANCE_SCAN_SCRIPT.exists():
        return JSONResponse({"error": "scan-script fehlt"}, status_code=500)
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, str(FINANCE_SCAN_SCRIPT),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=str(PROJECT_ROOT),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        if proc.returncode != 0:
            return JSONResponse({"error": stderr.decode("utf-8", errors="replace")[:500]}, status_code=500)
    except asyncio.TimeoutError:
        return JSONResponse({"error": "Scan-Timeout"}, status_code=504)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return _finance_inbox_read()
