"""Rechnungs-Agent: mehrstufiger Workflow von der Zusage zur fertigen Rechnung.

Trigger: manuell. der Nutzer sagt "X hat zugesagt, Leistung Y, Betrag Z" (per
Chat, WhatsApp oder Onboarding-Formular). Daraus baut der Agent eine prüfbare
Vorschau, NICHT sofort eine echte Rechnung.

Schritte: Kontakt auflösen -> Positionen + Selbst-Check -> Freigabe-Vorschau.
Erst auf ausdrückliche Freigabe (approve_invoice) wird die echte, nummerierte
Lexware-Rechnung erzeugt, das PDF gerendert und der Versandweg vorbereitet.
So verbrennt ein verworfener Entwurf keine Rechnungsnummer.

Bausteine aus dem Bestand:
- modules.lexware.providers.lexoffice (search_contacts, build_line_item,
  create_invoice, render_pdf, download_file)
- workflows.start_run / add_step / finish_run / review_background_run (Lauf-Protokoll + Lauf-Urteil)
- klaus_channel.post (proaktiver Hinweis im Klaus-Channel)
- config/invoice-learning.json (Lern-Kreis: contact_id + Versandweg pro Kunde)
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

_log = logging.getLogger("invoice.intake")

WORKFLOW_KEY = "agent.invoice"
PING_SOURCE = "rechnungs-agent"

_ROOT = Path(__file__).resolve().parents[2]
_LEARNING_PATH = _ROOT / "config" / "invoice-learning.json"
_UPLOADS_DIR = _ROOT / "data" / "uploads"
_PUBLIC_BASE = "https://agent-control.example.ts.net"


# ── Lern-Kreis: pro Kunde Lexware-Kontakt + bevorzugter Versandweg ──

def _load_learning() -> dict[str, Any]:
    try:
        return json.loads(_LEARNING_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"customers": {}, "fail_streak": 0, "fail_streak_max": 3}


def _save_learning(data: dict[str, Any]) -> None:
    _LEARNING_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LEARNING_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _customer_memory(customer: str) -> dict[str, Any]:
    return _load_learning().get("customers", {}).get(customer.strip().lower(), {})


def learn_customer(customer: str, *, contact_id: str = "", channel: str = "") -> None:
    """Merkt sich pro Kunde Lexware-Kontakt und Versandweg für den nächsten Lauf."""
    data = _load_learning()
    key = customer.strip().lower()
    entry = data.setdefault("customers", {}).setdefault(key, {})
    if contact_id:
        entry["contact_id"] = contact_id
    if channel:
        entry["channel"] = channel
    entry["name"] = customer.strip()
    _save_learning(data)


def _bump_fail_streak(reset: bool = False) -> int:
    data = _load_learning()
    data["fail_streak"] = 0 if reset else int(data.get("fail_streak", 0)) + 1
    _save_learning(data)
    return data["fail_streak"]


# ── Positionen + Selbst-Check ──

def _normalize_positions(positions: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """Säubert die Positionsliste und sammelt Auffälligkeiten für den Selbst-Check."""
    from modules.lexware.providers.lexoffice import build_line_item

    clean: list[dict[str, Any]] = []
    warnings: list[str] = []
    for p in positions:
        name = (p.get("name") or "").strip()
        if not name:
            warnings.append("Position ohne Bezeichnung übersprungen")
            continue
        try:
            qty = float(p.get("quantity", 1) or 1)
            price = float(p.get("unit_price", 0) or 0)
        except (TypeError, ValueError):
            warnings.append(f"Position '{name}' hat keinen gültigen Betrag")
            continue
        if qty <= 0:
            warnings.append(f"Position '{name}' hat Menge {qty}")
        if price <= 0:
            warnings.append(f"Position '{name}' hat Einzelpreis {price:.2f} €")
        clean.append(
            build_line_item(
                name=name,
                quantity=qty,
                unit_price=price,
                unit_name=(p.get("unit_name") or "Stück").strip() or "Stück",
                description=(p.get("description") or "").strip(),
            )
        )
    return clean, warnings


def _total(line_items: list[dict[str, Any]]) -> float:
    return round(
        sum(
            float(li["quantity"]) * float(li["unitPrice"]["netAmount"])
            for li in line_items
        ),
        2,
    )


# ── Hauptlauf: Vorschau bauen, nichts senden, nichts finalisieren ──

async def run_invoice(
    customer: str,
    positions: list[dict[str, Any]],
    *,
    contact_id: str = "",
    title: str = "Rechnung",
    intro: str = "",
    channel_pref: str = "",
    trigger: str = "manual",
) -> dict[str, Any]:
    """Baut eine prüfbare Rechnungs-Vorschau. Legt KEINE echte Rechnung an.

    Rückgabe: {run_id, ready, needs_contact, item, ping}
    """
    import workflows
    from modules.klaus_channel import core as channel

    customer = (customer or "").strip()
    run_id = workflows.start_run(
        WORKFLOW_KEY,
        "Rechnungs-Agent",
        trigger=trigger,
        subject_type="customer",
        subject_ref=customer,
        conversation_id=channel.KLAUS_CHANNEL_ID,
    )

    try:
        mem = _customer_memory(customer)
        if not contact_id:
            contact_id = mem.get("contact_id", "")
        if not channel_pref:
            channel_pref = mem.get("channel", "")

        # --- Schritt 1: Lexware-Kontakt auflösen ---
        from modules.lexware.providers import lexoffice as lex

        contact_name = ""
        needs_contact = False
        if contact_id:
            try:
                c = await lex.get_contact(contact_id)
                contact_name = (
                    (c.get("company") or {}).get("name")
                    or " ".join(
                        x for x in [
                            (c.get("person") or {}).get("firstName"),
                            (c.get("person") or {}).get("lastName"),
                        ] if x
                    )
                    or customer
                )
            except Exception as e:  # noqa: BLE001
                contact_id = ""
                _log.warning("get_contact failed: %s", e)

        if not contact_id:
            matches = await lex.search_contacts(customer) if customer else []
            if len(matches) == 1:
                contact_id = matches[0].get("id", "")
                contact_name = (
                    (matches[0].get("company") or {}).get("name")
                    or matches[0].get("name")
                    or customer
                )
            elif len(matches) > 1:
                needs_contact = True
                workflows.add_step(
                    run_id, "contact", "Kontakt mehrdeutig", "warning",
                    f"{len(matches)} Treffer für '{customer}' in Lexware",
                    {"matches": [{"id": m.get("id"),
                                  "name": (m.get("company") or {}).get("name") or m.get("name")}
                                 for m in matches[:6]]},
                )
            else:
                needs_contact = True
                workflows.add_step(
                    run_id, "contact", "Kontakt fehlt", "warning",
                    f"'{customer}' nicht in Lexware gefunden, Rechnungsadresse offen",
                )

        if not needs_contact:
            workflows.add_step(
                run_id, "contact", "Kontakt aufgelöst", "ok",
                contact_name or customer, {"contact_id": contact_id, "name": contact_name},
            )

        # --- Schritt 2: Positionen + Selbst-Check ---
        line_items, warnings = _normalize_positions(positions or [])
        total = _total(line_items)
        check_status = "warning" if (warnings or total <= 0) else "ok"
        workflows.add_step(
            run_id, "positions", "Positionen geprüft", check_status,
            f"{len(line_items)} Position(en), {total:.2f} € gesamt"
            + (f" · {len(warnings)} Hinweis(e)" if warnings else ""),
            {"count": len(line_items), "total": total, "warnings": warnings,
             "positions": [{"name": li["name"], "quantity": li["quantity"],
                            "unit_price": li["unitPrice"]["netAmount"]} for li in line_items]},
        )

        ready = bool(contact_id) and len(line_items) > 0 and total > 0

        item = {
            "idx": 0,
            "customer": customer,
            "contact_id": contact_id,
            "contact_name": contact_name,
            "title": title,
            "intro": intro,
            "channel": channel_pref,
            "line_items": line_items,
            "total": total,
            "warnings": warnings,
            "needs_contact": needs_contact,
            "status": "ready" if ready else "blocked",
        }

        # --- Schritt 3: Freigabe vorbereiten ---
        workflows.add_step(
            run_id, "await_approval", "Wartet auf Freigabe", "ok",
            "Vorschau bereit, noch keine echte Rechnung angelegt" if ready
            else "Erst Kontakt/Positionen klären, dann freigeben",
            {"ready": ready},
        )

        # --- Schritt 4: Hinweis in den Klaus-Channel ---
        pos_line = ", ".join(li["name"] for li in line_items[:3]) or "keine Position"
        if ready:
            body = (
                f"**Rechnungs-Agent:** Entwurf für {contact_name or customer} bereit. "
                f"{pos_line}, {total:.2f} € gesamt. Schau drüber, auf dein OK lege ich "
                f"die echte Lexware-Rechnung an und mache sie versandfertig. Ich sende nichts ohne Freigabe."
            )
        elif needs_contact:
            body = (
                f"**Rechnungs-Agent:** Zusage von {customer} erkannt ({pos_line}, {total:.2f} €), "
                f"aber ich finde keinen eindeutigen Lexware-Kontakt. Sag mir die Rechnungsadresse "
                f"oder welchen Kontakt ich nehmen soll, dann baue ich den Entwurf fertig."
            )
        else:
            body = (
                f"**Rechnungs-Agent:** Entwurf für {customer} ist noch unvollständig "
                f"({pos_line}, {total:.2f} €). Ich brauche gültige Positionen, dann gehts weiter."
            )
        ping = channel.post(body, source=PING_SOURCE, dedupe_key=f"invoice:{run_id}", cooldown_sec=0)

        workflows.finish_run(run_id, "done", result={
            "ready": ready, "needs_contact": needs_contact, "total": total,
            "items": [item],
            "payload": {"important": True, "changed": ready},
        })
        workflows.review_background_run(run_id)
        _bump_fail_streak(reset=True)

        return {"run_id": run_id, "ready": ready, "needs_contact": needs_contact,
                "item": item, "ping": ping}

    except Exception as e:  # noqa: BLE001
        workflows.add_step(run_id, "error", "Fehler im Lauf", "error", str(e)[:200])
        workflows.finish_run(run_id, "error", error=str(e)[:500])
        workflows.review_background_run(run_id)
        streak = _bump_fail_streak()
        max_streak = _load_learning().get("fail_streak_max", 3)
        if streak >= max_streak:
            try:
                from modules.klaus_channel import core as channel
                channel.post(
                    f"**Rechnungs-Agent** ist {streak}x in Folge gescheitert, zuletzt: {str(e)[:160]}. "
                    f"Da stimmt etwas Grundsätzliches, schau bitte drauf.",
                    source=PING_SOURCE, dedupe_key=f"invoice-failstreak:{streak}", force=True,
                )
            except Exception:
                pass
        raise


def list_runs(limit: int = 10) -> list[dict[str, Any]]:
    """Letzte Rechnungs-Läufe inkl. Entwürfe für die InfoPane-Section."""
    import workflows
    return workflows.recent_runs(limit=limit, workflow_key=WORKFLOW_KEY, visible_only=False)


def _find_item(run_id: str, idx: int) -> tuple[dict | None, dict | None, str]:
    import workflows
    runs = workflows.recent_runs(limit=50, workflow_key=WORKFLOW_KEY, visible_only=False)
    run = next((r for r in runs if r.get("id") == run_id), None)
    if not run:
        return None, None, "Lauf nicht gefunden"
    items = (run.get("result") or {}).get("items") or []
    item = next((d for d in items if int(d.get("idx", -1)) == int(idx)), None)
    if not item:
        return run, None, "Entwurf nicht gefunden"
    return run, item, ""


async def approve_invoice(run_id: str, idx: int = 0) -> dict[str, Any]:
    """Freigabe: legt JETZT die echte, nummerierte Lexware-Rechnung an, rendert das
    PDF und macht es versandfertig. Nur auf ausdrückliche Freigabe. Kein Doppellauf.
    """
    import workflows
    from modules.lexware.providers import lexoffice as lex

    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    if not item.get("contact_id"):
        return {"ok": False, "error": "Kein Lexware-Kontakt am Entwurf, erst Kontakt klären"}

    # Doppel-Anlage verhindern: schon ein invoiced-Step für diesen idx?
    for s in (run.get("steps") or []):
        if s.get("step_key") == f"invoiced_{idx}":
            return {"ok": False, "error": "schon angelegt"}

    try:
        res = await lex.create_invoice(
            contact_id=item["contact_id"],
            line_items=item["line_items"],
            finalize=True,
            intro=item.get("intro", ""),
            title=item.get("title", "Rechnung"),
        )
        invoice_id = res.get("id", "")
        number = res.get("voucherNumber", "")
    except Exception as e:  # noqa: BLE001
        workflows.add_step(run_id, f"invoiced_{idx}", "Rechnung anlegen", "error", str(e)[:200])
        return {"ok": False, "error": str(e)}

    # PDF rendern, herunterladen, klickbar ablegen
    pdf_url = ""
    try:
        file_id = await lex.render_pdf(invoice_id)
        data = await lex.download_file(file_id)
        _UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        safe = (number or invoice_id).replace("/", "-").replace(" ", "")
        fname = f"Rechnung-{safe}.pdf"
        (_UPLOADS_DIR / fname).write_bytes(data)
        pdf_url = f"{_PUBLIC_BASE}/uploads/{fname}"
    except Exception as e:  # noqa: BLE001
        _log.warning("invoice pdf render failed: %s", e)

    # Lern-Kreis: Kontakt + Versandweg für nächsten Lauf merken
    learn_customer(item.get("customer", ""), contact_id=item["contact_id"],
                   channel=item.get("channel", ""))

    workflows.add_step(
        run_id, f"invoiced_{idx}",
        f"Rechnung {number or invoice_id} angelegt", "ok",
        f"{item.get('total', 0):.2f} € · {item.get('contact_name') or item.get('customer')}",
        {"invoice_id": invoice_id, "number": number, "pdf_url": pdf_url},
    )
    return {"ok": True, "invoice_id": invoice_id, "number": number,
            "pdf_url": pdf_url, "total": item.get("total")}


async def discard_invoice(run_id: str, idx: int = 0) -> dict[str, Any]:
    """Verwirft einen Entwurf. Da noch keine echte Rechnung existiert, bleibt
    der Nummernkreis sauber. Kein Lernen nötig, der Trigger ist immer manuell."""
    import workflows
    run, item, err = _find_item(run_id, idx)
    if err:
        return {"ok": False, "error": err}
    workflows.add_step(
        run_id, f"discarded_{idx}",
        f"Verworfen: {item.get('contact_name') or item.get('customer')}", "ok",
        "Entwurf verworfen, keine Rechnung angelegt",
    )
    return {"ok": True}
