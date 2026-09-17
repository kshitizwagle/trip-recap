from __future__ import annotations

from math import log

ANCHORS = ((120.0, 1.0), (1800.0, 3.0), (7200.0, 5.0), (28800.0, 7.0))


def compress_gap_seconds(real_seconds: float) -> float:
    """Map real travel time to a compact video duration using log interpolation."""
    if real_seconds <= 0:
        return 0.0
    if real_seconds <= ANCHORS[0][0]:
        return max(0.5, real_seconds / ANCHORS[0][0] * ANCHORS[0][1])
    if real_seconds >= ANCHORS[-1][0]:
        extra = log(real_seconds / ANCHORS[-1][0] + 1)
        return min(8.0, ANCHORS[-1][1] + 0.5 * extra)

    for (left_s, left_v), (right_s, right_v) in zip(ANCHORS, ANCHORS[1:]):
        if left_s <= real_seconds <= right_s:
            ratio = (log(real_seconds) - log(left_s)) / (log(right_s) - log(left_s))
            return left_v + ratio * (right_v - left_v)
    raise AssertionError("unreachable")
