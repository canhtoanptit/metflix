import {
  DEFAULT_MATURITY_CEILING,
  KIDS_MATURITY_CEILING,
  MATURITY_LEVELS,
  type MaturityLevel,
} from "@webflix/contracts";

/** 0 for `ALL` up to 4 for `18+`. */
export function maturityRank(level: MaturityLevel): number {
  return MATURITY_LEVELS.indexOf(level);
}

/** Negative when `a` is less mature than `b`, 0 when equal, positive otherwise. */
export function compareMaturity(a: MaturityLevel, b: MaturityLevel): number {
  return maturityRank(a) - maturityRank(b);
}

/** True when content rated `level` may be shown to a profile capped at `ceiling`. */
export function isWithinMaturityCeiling(level: MaturityLevel, ceiling: MaturityLevel): boolean {
  return compareMaturity(level, ceiling) <= 0;
}

/** Every level a profile capped at `ceiling` may see, for `IN (...)` filters. */
export function maturityLevelsUpTo(ceiling: MaturityLevel): MaturityLevel[] {
  return MATURITY_LEVELS.slice(0, maturityRank(ceiling) + 1);
}

/** The lower of two levels. */
export function minMaturity(a: MaturityLevel, b: MaturityLevel): MaturityLevel {
  return compareMaturity(a, b) <= 0 ? a : b;
}

/**
 * The effective ceiling of a profile: kids profiles never exceed `KIDS_MATURITY_CEILING`,
 * and a missing choice falls back to the default for the profile kind.
 */
export function resolveMaturityCeiling(isKids: boolean, requested?: MaturityLevel): MaturityLevel {
  if (isKids) return minMaturity(requested ?? KIDS_MATURITY_CEILING, KIDS_MATURITY_CEILING);
  return requested ?? DEFAULT_MATURITY_CEILING;
}
