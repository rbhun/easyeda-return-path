#!/usr/bin/env python3
"""Package this folder into an importable EasyEDA Pro extension (.eext = zip)."""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = ["extension.json", "README.md", "LICENSE", "NOTICE", "dist/index.js", "images/logo.png"]


def main() -> None:
    manifest = json.loads((ROOT / "extension.json").read_text())
    out_dir = ROOT / "build" / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{manifest['name']}_v{manifest['version']}.eext"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            path = ROOT / name
            if not path.exists() and name in ("LICENSE", "NOTICE"):
                path = ROOT.parent.parent / name
            data = path.read_bytes()
            if name == "extension.json":
                data = json.dumps(manifest, separators=(",", ":")).encode()
            archive.writestr(zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0)), data)
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
