"""`python/` を import path に入れて `pdf_ja` を読めるようにする。"""

from __future__ import annotations

import sys
from pathlib import Path

PYTHON_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PYTHON_DIR.parent

if str(PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(PYTHON_DIR))


import pytest


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return REPO_ROOT / "test" / "fixtures" / "pdf"
