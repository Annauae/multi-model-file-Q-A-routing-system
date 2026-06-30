from __future__ import annotations

import time


def ms_since(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)
