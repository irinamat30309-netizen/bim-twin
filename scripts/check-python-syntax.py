#!/usr/bin/env python3
"""Parse every tracked Python source file without creating bytecode files."""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files", "-z", "--", "*.py"],
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        print(f"Could not enumerate tracked Python sources: {exc}", file=sys.stderr)
        return 2

    sources = {
        (repo_root / entry.decode("utf-8")).resolve()
        for entry in result.stdout.split(b"\0")
        if entry
    }
    sources.add(Path(__file__).resolve())
    sources = {path for path in sources if path.is_file()}
    if not sources:
        print("No Python source files were found.", file=sys.stderr)
        return 2

    failures: list[tuple[Path, Exception]] = []
    for path in sorted(sources):
        try:
            ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        except (OSError, SyntaxError, UnicodeError) as exc:
            failures.append((path, exc))

    if failures:
        for path, exc in failures:
            print(f"{path.relative_to(repo_root)}: {exc}", file=sys.stderr)
        return 1

    print(f"Python syntax check passed for {len(sources)} source files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())