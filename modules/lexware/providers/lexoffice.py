"""Lexware Office API Client. Kontakte suchen, Rechnungen anlegen, PDF holen."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Any

import httpx

API = "https://api.lexoffice.io/v1"


def _key() -> str:
    k = os.environ.get("LEXWARE_API_KEY", "").strip()
    if not k:
        raise RuntimeError("LEXWARE_API_KEY fehlt in .env")
    return k


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    h = {
        "Authorization": f"Bearer {_key()}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


async def search_contacts(query: str, size: int = 20) -> list[dict]:
    """Sucht Kontakte ueber den name-Filter."""
    params = {"name": query, "size": size, "page": 0}
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(f"{API}/contacts", headers=_headers(), params=params)
        r.raise_for_status()
        return r.json().get("content", [])


async def get_contact(contact_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(f"{API}/contacts/{contact_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


def build_line_item(name: str, quantity: float, unit_price: float, *, unit_name: str = "Stück", description: str = "") -> dict:
    """Kleinunternehmer (vatfree): taxRatePercentage muss 0 sein."""
    return {
        "type": "custom",
        "name": name,
        "description": description,
        "quantity": quantity,
        "unitName": unit_name,
        "unitPrice": {
            "currency": "EUR",
            "netAmount": round(unit_price, 2),
            "taxRatePercentage": 0,
        },
        "discountPercentage": 0,
    }


async def create_invoice(
    contact_id: str,
    line_items: list[dict],
    *,
    finalize: bool = False,
    voucher_date: str | None = None,
    shipping_date: str | None = None,
    intro: str = "",
    remark: str = "",
    title: str = "Rechnung",
) -> dict:
    """Legt eine Rechnung an. finalize=True macht aus Draft eine offene Rechnung mit Nummer."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000+02:00")
    payload: dict[str, Any] = {
        "archived": False,
        "voucherDate": voucher_date or today,
        "address": {"contactId": contact_id},
        "lineItems": line_items,
        "totalPrice": {"currency": "EUR"},
        "taxConditions": {"taxType": "vatfree"},
        "shippingConditions": {
            "shippingDate": shipping_date or today,
            "shippingType": "service",
        },
        "title": title,
        "introduction": intro,
        "remark": remark or "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmer).",
    }
    params = {"finalize": "true"} if finalize else {}
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(f"{API}/invoices", headers=_headers(), params=params, json=payload)
        if r.status_code >= 300:
            raise RuntimeError(f"Lexware {r.status_code}: {r.text}")
        return r.json()


async def get_invoice(invoice_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(f"{API}/invoices/{invoice_id}", headers=_headers())
        r.raise_for_status()
        return r.json()


async def list_invoices(*, voucher_status: str = "open", size: int = 50) -> list[dict]:
    """Listet Rechnungen aus dem Voucherlist-Endpoint (gibt nur Metadaten)."""
    params = {"voucherType": "invoice", "voucherStatus": voucher_status, "size": size, "page": 0}
    async with httpx.AsyncClient(timeout=15) as cli:
        r = await cli.get(f"{API}/voucherlist", headers=_headers(), params=params)
        r.raise_for_status()
        return r.json().get("content", [])


async def list_vouchers(*, voucher_type: str = "purchaseinvoice", voucher_status: str = "any", size: int = 100) -> list[dict]:
    """Listet Belege/Eingangsrechnungen. voucher_type: purchaseinvoice|purchasecreditnote|salesinvoice.

    Mit 429-Retry: Lexware drosselt aggressiv, deshalb 3 Versuche mit exponentialem Backoff."""
    async with httpx.AsyncClient(timeout=20) as cli:
        return await _voucherlist_all(
            cli,
            {"voucherType": voucher_type, "voucherStatus": voucher_status, "size": size},
        )


async def _voucherlist_page(cli: httpx.AsyncClient, params: dict[str, Any]) -> dict:
    backoffs = [1.0, 3.0, 8.0]
    last_response: httpx.Response | None = None
    for attempt, wait in enumerate(backoffs):
        r = await cli.get(f"{API}/voucherlist", headers=_headers(), params=params)
        last_response = r
        if r.status_code == 429 and attempt < len(backoffs) - 1:
            await asyncio.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    if last_response is not None:
        last_response.raise_for_status()
    return {"content": []}


async def _voucherlist_all(cli: httpx.AsyncClient, base_params: dict[str, Any], *, max_pages: int = 50) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for page in range(max_pages):
        data = await _voucherlist_page(cli, {**base_params, "page": page})
        content = data.get("content", [])
        for item in content:
            vid = item.get("id")
            if vid and vid not in seen:
                seen.add(vid)
                out.append(item)
        if data.get("last") is True:
            break
        total_pages = data.get("totalPages")
        if isinstance(total_pages, int) and page >= total_pages - 1:
            break
        if not content:
            break
        await asyncio.sleep(0.2)
    return out


async def list_invoices_all(*, size: int = 100) -> list[dict]:
    """Alle Ausgangsrechnungen unabhaengig vom Status (open, paid, voided, overdue).

    Lexware-Voucherlist akzeptiert keinen einzelnen "any" fuer Invoices, deshalb
    fragen wir die relevanten Status getrennt ab und mergen. Drafts bleiben aussen vor.
    """
    statuses = ["open", "paid", "voided", "overdue"]
    out: list[dict] = []
    seen: set[str] = set()
    async with httpx.AsyncClient(timeout=20) as cli:
        for st in statuses:
            items = await _voucherlist_all(
                cli,
                {"voucherType": "invoice", "voucherStatus": st, "size": size},
            )
            for item in items:
                vid = item.get("id")
                if vid and vid not in seen:
                    seen.add(vid)
                    out.append(item)
            await asyncio.sleep(0.3)  # zwischen Status-Calls etwas Luft
    return out


async def cancel_invoice(invoice_id: str) -> dict:
    """Storniert eine finalisierte Rechnung via Credit Note. Spiegelt Positionen 1:1."""
    inv = await get_invoice(invoice_id)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00.000+02:00")
    payload: dict[str, Any] = {
        "archived": False,
        "voucherDate": today,
        "address": inv.get("address", {}),
        "lineItems": inv.get("lineItems", []),
        "totalPrice": {"currency": "EUR"},
        "taxConditions": inv.get("taxConditions", {"taxType": "vatfree"}),
        "title": "Rechnungskorrektur",
        "introduction": f"Storno zu Rechnung {inv.get('voucherNumber', invoice_id)}",
        "remark": "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmer).",
    }
    params = {"precedingSalesVoucherId": invoice_id, "finalize": "true"}
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.post(f"{API}/credit-notes", headers=_headers(), params=params, json=payload)
        if r.status_code >= 300:
            raise RuntimeError(f"Lexware {r.status_code}: {r.text}")
        return r.json()


async def render_pdf(invoice_id: str) -> str:
    """Liefert die documentFileId fuer die PDF. Erst nach finalize verfuegbar."""
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.get(f"{API}/invoices/{invoice_id}/document", headers=_headers())
        r.raise_for_status()
        return r.json()["documentFileId"]


async def download_file(file_id: str) -> bytes:
    async with httpx.AsyncClient(timeout=30) as cli:
        r = await cli.get(f"{API}/files/{file_id}", headers=_headers(extra={"Accept": "application/pdf"}))
        r.raise_for_status()
        return r.content


async def upload_voucher_file(filename: str, data: bytes, content_type: str = "application/pdf") -> dict:
    """Laedt eine Beleg-Datei in Lexware hoch. Sie landet in der Belegerfassung
    (Posteingang) und wartet dort auf manuelle Verbuchung durch der Nutzer/Steuerberater."""
    headers = {"Authorization": f"Bearer {_key()}", "Accept": "application/json"}
    files = {"file": (filename, data, content_type)}
    form = {"type": "voucher"}
    async with httpx.AsyncClient(timeout=60) as cli:
        r = await cli.post(f"{API}/files", headers=headers, files=files, data=form)
        if r.status_code >= 300:
            raise RuntimeError(f"Lexware {r.status_code}: {r.text}")
        return r.json()
