"""Experiment analysis (`analyse-experiments`) and a synthetic generator to calibrate it."""

from webflix_recs.experiments.analysis import (
    METRICS,
    PreRegistrationError,
    analyse_frames,
    fixed_horizon_power,
    msprt_power,
    run_analysis,
)

__all__ = [
    "METRICS",
    "PreRegistrationError",
    "analyse_frames",
    "fixed_horizon_power",
    "msprt_power",
    "run_analysis",
]
