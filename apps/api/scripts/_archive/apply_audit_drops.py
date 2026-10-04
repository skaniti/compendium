"""Apply approved drops from a v2.2 audit run.

Reads the audit JSON produced by `audit_v2_2_reprocess.py` and marks pages
in `candidates_to_drop` as inactive (`pages.status = 'inactive'`) unless an
exclusion file is provided.

Workflow:

1. Run audit: ``python scripts/_archive/audit_v2_2_reprocess.py --user-id 152``
2. Review the audit JSON's ``candidates_to_drop`` array. Optionally write an
   exclusion file: a JSON list of page_ids that you've decided to KEEP active
   despite the v2.2 verdict (i.e., v2.2 said skip but you disagree).
3. Apply: ``python scripts/_archive/apply_audit_drops.py --audit <path> [--exclude <path>] [--execute]``

Dry-run by default. Pass ``--execute`` to actually mutate the DB.

Idempotent: re-running with the same audit + exclude files produces the
same outcome. Pages already at status='inactive' are silently kept inactive.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from backend.db.connection import get_conn  # noqa: E402


def load_exclude(path: Path | None) -> set[int]:
    """Load exclusion list (page_ids to KEEP active despite v2.2 saying skip)."""
    if path is None:
        return set()
    if not path.exists():
        print(f"Exclude file not found: {path}", file=sys.stderr)
        sys.exit(2)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        print(f"Exclude file must be a JSON list of page_ids, got {type(data).__name__}", file=sys.stderr)
        sys.exit(2)
    return {int(x) for x in data}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True, help="Path to audit JSON")
    parser.add_argument(
        "--exclude",
        default=None,
        help="Path to JSON list of page_ids to KEEP active (overrides v2.2's skip verdict)",
    )
    parser.add_argument("--execute", action="store_true", help="Actually mutate DB (default: dry-run)")
    args = parser.parse_args()

    audit_path = Path(args.audit).resolve()
    if not audit_path.exists():
        print(f"Audit file not found: {audit_path}", file=sys.stderr)
        return 2

    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    candidates = audit.get("candidates_to_drop", [])
    exclude = load_exclude(Path(args.exclude).resolve() if args.exclude else None)

    to_drop = [c for c in candidates if int(c["page_id"]) not in exclude]
    n_excluded = len(candidates) - len(to_drop)

    print(f"Audit: {audit_path.name}")
    print(f"  candidates_to_drop:  {len(candidates)}")
    print(f"  excluded (kept):     {n_excluded}")
    print(f"  to drop:             {len(to_drop)}")
    print()

    if not to_drop:
        print("Nothing to drop. Exiting.")
        return 0

    print("Sample of pages to drop (first 10):")
    for c in to_drop[:10]:
        title = (c.get("title") or "")[:60]
        url = (c.get("url") or "")[:80]
        print(f"  page_id={c['page_id']}  domain={c.get('domain')}  title={title!r}")
        print(f"    url: {url}")
    print()

    if not args.execute:
        print("DRY RUN. Re-run with --execute to apply.")
        return 0

    page_ids = [int(c["page_id"]) for c in to_drop]
    # Canonical "pruned" value is 'archived' (per pages_human_status_check
    # constraint: NULL | 'active' | 'archived'). Both `status` and
    # `human_status` get the same value to reflect that this is a
    # user-curation drop, not an internal-state transition.
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pages
                SET status = 'archived',
                    human_status = 'archived'
                WHERE id = ANY(%s) AND status = 'active'
                """,
                (page_ids,),
            )
            n_affected = cur.rowcount
        conn.commit()

    print(f"EXECUTED: {n_affected} pages marked inactive.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
