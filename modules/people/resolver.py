"""Tag-Resolver: Tag-String (z. B. '@example-person') zu Entitaet aus
`data/people.db` aufloesen.

- Erster Treffer aus `people.slug`, dann `projects.slug`.
- Fuzzy-Fallback: people.name LIKE / projects.name LIKE.
- Mehrere Treffer => niedrigste ID gewinnt.

Verwendung:
    from modules.people.resolver import resolve_tag
    hit = resolve_tag("@example-person")
    # -> {"kind": "person", "id": 197, "name": "Example Person",
    #     "slug": "example-person"}

CLI:
    python3 -m modules.people.resolver @example-person @example-firm @unknown
"""
from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path
from typing import Optional

DB = Path.home() / "agent/data/people.db"


def _normalize(tag: str) -> str:
    """'@Example-Person' -> 'example-person'."""
    t = tag.strip().lstrip("@").lower()
    t = re.sub(r"\s+", "-", t)
    return t


def _con() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def resolve_tag(tag: str) -> Optional[dict]:
    """Tag zu {kind, id, name, slug} aufloesen. None wenn nichts passt."""
    slug = _normalize(tag)
    if not slug:
        return None

    con = _con()
    try:
        # 1) exakter slug-Treffer in people
        r = con.execute(
            "SELECT id, slug, name FROM people WHERE slug = ? LIMIT 1", (slug,)
        ).fetchone()
        if r:
            return {"kind": "person", "id": r["id"], "name": r["name"],
                    "slug": r["slug"]}

        # 2) exakter slug-Treffer in projects
        r = con.execute(
            "SELECT id, slug, name FROM projects WHERE slug = ? LIMIT 1", (slug,)
        ).fetchone()
        if r:
            return {"kind": "project", "id": r["id"], "name": r["name"],
                    "slug": r["slug"]}

        # 3) fuzzy: name LIKE (people first, kleinste id)
        pat = f"%{slug.replace('-', '%')}%"
        r = con.execute(
            "SELECT id, slug, name FROM people WHERE LOWER(name) LIKE ? "
            "ORDER BY id LIMIT 1", (pat,)
        ).fetchone()
        if r:
            return {"kind": "person", "id": r["id"], "name": r["name"],
                    "slug": r["slug"], "match": "fuzzy"}

        # 4) fuzzy: projects.name LIKE
        r = con.execute(
            "SELECT id, slug, name FROM projects WHERE LOWER(name) LIKE ? "
            "ORDER BY id LIMIT 1", (pat,)
        ).fetchone()
        if r:
            return {"kind": "project", "id": r["id"], "name": r["name"],
                    "slug": r["slug"], "match": "fuzzy"}

        return None
    finally:
        con.close()


def resolve_many(tags: list[str]) -> dict[str, Optional[dict]]:
    """Mehrere Tags auf einmal. Praktisch fuer Audit-Skripte."""
    return {t: resolve_tag(t) for t in tags}


def _main(argv: list[str]) -> int:
    if not argv:
        print("usage: python3 -m modules.people.resolver @tag1 @tag2 ...",
              file=sys.stderr)
        return 2
    for t in argv:
        hit = resolve_tag(t)
        if hit is None:
            print(f"{t:30s} ❌ nicht aufloesbar")
        else:
            kind = hit["kind"]
            extra = " (fuzzy)" if hit.get("match") == "fuzzy" else ""
            print(f"{t:30s} ✓ {kind:7s} id={hit['id']:<4} "
                  f"slug={hit['slug']:<25} name={hit['name']}{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
