#!/usr/bin/env python3
"""Copy the PyInstaller --onefile output to src-tauri/binaries/ with the correct target-triple suffix."""
import platform
import shutil
from pathlib import Path

TRIPLES = {
    ("linux",   "x86_64"):  "x86_64-unknown-linux-gnu",
    ("linux",   "aarch64"): "aarch64-unknown-linux-gnu",
    ("darwin",  "x86_64"):  "x86_64-apple-darwin",
    ("darwin",  "arm64"):   "aarch64-apple-darwin",
    ("windows", "amd64"):   "x86_64-pc-windows-msvc",
    ("windows", "x86_64"):  "x86_64-pc-windows-msvc",
}

system = platform.system().lower()
machine = platform.machine().lower()
triple = TRIPLES.get((system, machine))
if not triple:
    raise SystemExit(f"Unknown platform: {system}/{machine}")

ext = ".exe" if system == "windows" else ""
src = Path("dist") / f"linxiv-api{ext}"
if not src.exists():
    raise SystemExit(f"PyInstaller output not found at {src}. Run pyinstaller first.")

dest_dir = Path("src-tauri") / "binaries"
dest_dir.mkdir(parents=True, exist_ok=True)
dest = dest_dir / f"linxiv-api-{triple}{ext}"

shutil.copy2(src, dest)
print(f"✓ Sidecar staged: {dest}")
