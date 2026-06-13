"""Value flywheel for turning local Agent Control advantages into products."""
from __future__ import annotations

from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]


def value_flywheel_manifest() -> dict[str, Any]:
    assets = [
        {
            "id": "private_memory",
            "label": "Privates Langzeitgedächtnis",
            "advantage": "Agent Control hat gewachsene lokale Erinnerung, Daily Logs, Learnings und Kontext-Routing statt nur Chatverlauf.",
            "loop": "Jeder Auftrag erzeugt ein Learning, jedes Learning wird Tool-, Skill-, Policy- oder Angebotskandidat.",
            "product": "Kunden-Gedächtnis: lokaler Firmenagent mit Ablaufwissen, Tonalität und Quellen.",
        },
        {
            "id": "security_harness",
            "label": "Broker- und Sicherheits-Harness",
            "advantage": "Tools, Gateway, Capability-Token, Approval, Audit, Sandbox und Prozess-Governor sind ein eigener Schutzrahmen.",
            "loop": "Neue Fähigkeiten gehen erst durch Tool-Katalog, Policy, Benchmark und Approval, bevor sie produktiv werden.",
            "product": "Sicherer KMU-Agent: Assistenz mit Freigabe bei Mail, Kalender, Dateien, Jobs und Admin-Aktionen.",
        },
        {
            "id": "artifact_system",
            "label": "Artefakt- und Entscheidungsmaschine",
            "advantage": "Antworten werden nicht nur Text, sondern strukturierte Artefakte, Prüfberichte, Briefings und wiederverwendbare Vorlagen.",
            "loop": "Jede Beratung kann als HTML/MD/Template wiederkommen und zum Angebot oder Workshop-Modul werden.",
            "product": "Beratungs-OS: Briefings, Reports, Workshop-Unterlagen und Follow-up-Automation.",
        },
        {
            "id": "knowledge_ingest",
            "label": "Web zu eigenem Workspace-Wissen",
            "advantage": "Agent Control kann Quellen broker-gesichert abrufen und als lokales Markdown/JSON mit Quelle, Hash und Vorschau speichern.",
            "loop": "Jede besuchte oder recherchierte Quelle wird wieder auffindbares Material für Briefings, Kundenwissen und Angebote.",
            "product": "Recherche-OS: Perplexity-artige Antworten plus eigenes Firmenarchiv statt flüchtiger Browser-Tabs.",
        },
        {
            "id": "agent_identity",
            "label": "Agent-Identität statt Modell-Chat",
            "advantage": "Klaus trennt Identität, Engine und Kundenkontext; andere Systeme starten meist engine-zentriert.",
            "loop": "Pro Kunde entsteht ein eigenes Profil mit Grenzen, Sprache, Wissen und messbaren Fähigkeiten.",
            "product": "Custom Agent pro Kunde: lokaler Mitarbeiter-Agent mit prüfbarem Verhalten.",
        },
        {
            "id": "installable_core",
            "label": "Installierbarer lokaler Kern",
            "advantage": "Install-Readiness, Shell-Allowlist und Benchmark machen den Stand portierbar statt nur experimentell.",
            "loop": "Jede neue Kundenvoraussetzung wird ein Readiness-Check und später ein Setup-Profil.",
            "product": "One-Install Agent Control: kleines Paket für sichere lokale KI in KMU.",
        },
    ]
    offers = [
        {
            "id": "secure_ai_sprint",
            "label": "Secure AI Sprint",
            "buyer": "KMU-Geschäftsführung",
            "promise": "In 2-4 Stunden ein sicherer lokaler Agent-Start mit klaren Freigaben und ersten Workflows.",
        },
        {
            "id": "company_memory",
            "label": "Firmen-Gedächtnis",
            "buyer": "Teams mit wiederkehrender Beratung, Vertrieb oder Operations",
            "promise": "Wissen, Entscheidungen und Abläufe werden abrufbar, ohne Kundendaten in eine Cloud zu werfen.",
        },
        {
            "id": "agent_control_harness",
            "label": "Agent-Control-Harness",
            "buyer": "Unternehmen, die eigene KI-Agenten bauen wollen",
            "promise": "Tool-Broker, Approval, Audit, Sandbox und Benchmark als Fundament statt freier Modell-Aktion.",
        },
    ]
    harness_steps = [
        "Jeden erfolgreichen manuellen Ablauf als Skill/Tool-Kandidat erfassen.",
        "Jede neue riskante Fähigkeit zuerst in Policy + Benchmark eintragen.",
        "Jeden Kundenstart über Install-Readiness und Capability-Matrix prüfen.",
        "Jedes Ergebnis als Artefakt, Vorlage oder Angebotsmodul speichern.",
        "Jede externe Quelle als Knowledge-Objekt mit URL, Hash und bereinigtem Text ablegen.",
        "Monatlich die häufigsten wiederholten Abläufe in bezahlbare Pakete bündeln.",
    ]
    return {
        "status": "actionable",
        "score": {"assets": len(assets), "offers": len(offers), "harness_steps": len(harness_steps)},
        "unique_assets": assets,
        "offers": offers,
        "harness_steps": harness_steps,
        "next_tool_gap": "customer_memory_namespace",
        "verify_command": "python3 scripts/agent-control-capability-benchmark.py",
    }
