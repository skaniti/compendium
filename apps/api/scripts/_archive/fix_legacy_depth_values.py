"""One-off migration: overwrite legacy processing_depth values.

The old narrative journey pipeline set processing_depth to 'full' or
'surface'. The current skip gate only produces 'processed' or 'skipped'.
This script normalises the legacy values to 'processed'.

Idempotent — safe to run multiple times.

Usage:
    python -m scripts.fix_legacy_depth_values
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.db.connection import get_conn


def main() -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE pages
                SET processing_depth = 'processed'
                WHERE processing_depth IN ('full', 'surface')
                """,
            )
            count = cur.rowcount
        conn.commit()

    if count:
        print(f"Updated {count} page(s): full/surface → processed")
    else:
        print("No legacy values found. Nothing to update.")


if __name__ == "__main__":
    main()
