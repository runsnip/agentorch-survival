#!/usr/bin/env python3
"""Pack this add-on into the zip AgentOrch downloads, plus its checksum.

    python3 tools/pack.py                 # → dist/<name>.zip, dist/<name>.zip.sha256
    python3 tools/pack.py --tag v0.1.0    # same, and fail unless the tag matches manifest.json's version

The release workflow (.github/workflows/release.yml) runs it for a pushed tag and attaches both files
to the GitHub release; AgentOrch fetches releases/latest/download/<name>.zip (and .sha256).
Repository files (tools, workflows, dev pages, notes, source portraits) stay out of the zip.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", ".github", "tools", "dist", "dev", "__pycache__"}
SKIP_SUFFIX = {".png", ".md", ".DS_Store"}
KEEP = {"LICENSE", "NOTICE"}   # the licence travels with the pack


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", help="the release tag; must be v<manifest version>")
    a = ap.parse_args()
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    name, version = manifest["name"], manifest["version"]
    if a.tag and a.tag.lstrip("v") != version:
        print(f"tag {a.tag} doesn't match manifest version {version}", file=sys.stderr)
        return 1
    files = [p for p in sorted(ROOT.rglob("*")) if p.is_file()
             and not SKIP_DIRS & set(p.relative_to(ROOT).parts)
             and (p.name in KEEP or (p.suffix not in SKIP_SUFFIX and not p.name.startswith(".")))]
    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / f"{name}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            # images and models are compressed already
            z.write(p, p.relative_to(ROOT), zipfile.ZIP_STORED if p.suffix in {".jpg", ".glb", ".webp"} else zipfile.ZIP_DEFLATED)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    (dist / f"{name}.zip.sha256").write_text(f"{digest}  {out.name}\n")
    print(f"{out}  v{version}  {len(files)} files  {out.stat().st_size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
