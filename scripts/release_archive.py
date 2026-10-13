#!/usr/bin/env python3
"""Create/check the README download against the current repository sources."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "latest.zip"
PREFIX = "cadence/"


def source_files():
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, check=True, stdout=subprocess.PIPE,
    )
    names = sorted(set(result.stdout.decode().rstrip("\0").split("\0")))
    files = {}
    for name in names:
        if not name or name == "latest.zip" or name.startswith(("dist/", "node_modules/")):
            continue
        path = ROOT / name
        if not path.is_file():  # deleted tracked paths are absent from the release
            continue
        if path.name.startswith(".env") or path.is_symlink():
            raise ValueError(f"Refusing private environment/symlink input: {name}")
        files[name] = path.read_bytes()
    return files


def manifest(files):
    records = {name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for name, data in files.items()}
    return json.dumps({"format": 1, "files": records}, sort_keys=True, indent=2).encode() + b"\n"


def check_archive(files):
    if not ARCHIVE.exists():
        raise ValueError("latest.zip is missing; run npm run release:archive")
    expected = {PREFIX + name: data for name, data in files.items()}
    expected[PREFIX + "RELEASE-MANIFEST.json"] = manifest(files)
    with zipfile.ZipFile(ARCHIVE) as archive:
        if len(archive.namelist()) != len(expected) or set(archive.namelist()) != set(expected):
            raise ValueError("Archive file inventory differs from source; regenerate latest.zip")
        for name, data in expected.items():
            if archive.read(name) != data:
                raise ValueError(f"Stale archive entry: {name}; regenerate latest.zip")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = source_files()
    if not args.check:
        # Fixed metadata makes the same source produce byte-identical archives.
        with zipfile.ZipFile(ARCHIVE, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            entries = {**files, "RELEASE-MANIFEST.json": manifest(files)}
            for name, data in sorted(entries.items()):
                info = zipfile.ZipInfo(PREFIX + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data)
    check_archive(files)
    print(f"Release archive matches {len(files)} source files.")


if __name__ == "__main__":
    main()
