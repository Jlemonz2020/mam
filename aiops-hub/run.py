#!/usr/bin/env python3
"""AIOpsHub command line entry point."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from aiopshub.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
