#!/usr/bin/env python3
"""Validate exact public catalog parity after a synthetic PostgreSQL restore.

A PostgreSQL 16 dump/restore can re-deparse two specific array-coercion CHECK
constraints. This verifier permits only the TWO EXACT reviewed text pairs.
It never normalizes grants, functions, roles, RLS, other constraints or content.
No DB connections, network, source modification or SQL execution.
"""
from __future__ import annotations

import difflib
import hashlib
from pathlib import Path
import sys

EXPECTED_SOURCE_SHA256 = "6dd1b992a88cb9c5dfd87007ab127b3d2da8ab0e32fa408784fc1cc28e7df977"
KNOWN_DEPARSE_VARIANTS = {
    "constraint|invitation_rate_limits_action|invitation_rate_limits|CHECK (((action)::text = ANY ((ARRAY['issue'::character varying, 'accept'::character varying])::text[])))": "constraint|invitation_rate_limits_action|invitation_rate_limits|CHECK (((action)::text = ANY (ARRAY[('issue'::character varying)::text, ('accept'::character varying)::text])))",
    "constraint|invitation_rate_limits_kind|invitation_rate_limits|CHECK (((bucket_kind)::text = ANY ((ARRAY['actor'::character varying, 'network'::character varying])::text[])))": "constraint|invitation_rate_limits_kind|invitation_rate_limits|CHECK (((bucket_kind)::text = ANY (ARRAY[('actor'::character varying)::text, ('network'::character varying)::text])))",
}


def compare_catalogs(source: bytes, restored: bytes, *, pin_source: bool = True) -> int:
    """Return count of exact approved deparse variants; reject all other changes."""
    source_digest = hashlib.sha256(source).hexdigest()
    if pin_source and source_digest != EXPECTED_SOURCE_SHA256:
        raise ValueError("Source catalog does not match independently reviewed fingerprint")
    if not source.endswith(b"\n") or not restored.endswith(b"\n"):
        raise ValueError("Catalog snapshot is truncated or missing final newline")
    try:
        before = source.decode("utf-8").splitlines()
        after = restored.decode("utf-8").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError("Catalog snapshots must be UTF-8") from exc
    if len(before) != len(after):
        raise ValueError("Catalog row count changed during restore")
    accepted = 0
    for line_number, (original, recovered) in enumerate(zip(before, after), start=1):
        if original == recovered:
            continue
        if original in KNOWN_DEPARSE_VARIANTS and KNOWN_DEPARSE_VARIANTS[original] == recovered:
            accepted += 1
            continue
        raise ValueError(f"Unexpected public catalog difference at line {line_number}")
    return accepted


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: python3 verify-restored-catalog.py SOURCE.txt RESTORED.txt", file=sys.stderr)
        return 2
    try:
        source = Path(sys.argv[1]).read_bytes()
        restored = Path(sys.argv[2]).read_bytes()
        count = compare_catalogs(source, restored)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print("========== RESTORED SECURITY CATALOG DIFFERENCES (METADATA ONLY) ==========", file=sys.stderr)
        try:
            b = source.decode("utf-8", errors="replace").splitlines() if 'source' in locals() else []
            a = restored.decode("utf-8", errors="replace").splitlines() if 'restored' in locals() else []
            difference = difflib.unified_diff(b, a, fromfile="reviewed-source", tofile="restored", lineterm="")
            for index, line in enumerate(difference):
                if index >= 100:
                    print("(diff truncated at 100 lines)", file=sys.stderr)
                    break
                print(line, file=sys.stderr)
        except Exception:
            print("Unable to display metadata diff", file=sys.stderr)
        return 1
    print(f"PASS: restored catalog matches reviewed source ({count} narrowly approved PostgreSQL CHECK deparse variant(s))")
    if count:
        print("NOTE: only explicit text-cast spelling of two CHECK expressions differed; raw snapshots were preserved")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
