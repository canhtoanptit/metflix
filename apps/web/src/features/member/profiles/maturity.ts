import { KIDS_MATURITY_CEILING, MATURITY_LEVELS } from "@webflix/contracts";

export type MaturityLevel = (typeof MATURITY_LEVELS)[number];

export const MATURITY_COPY: Record<MaturityLevel, { label: string; description: string }> = {
  ALL: { label: "All ages", description: "Only titles suitable for everyone." },
  "7+": { label: "7+ · Older kids", description: "Titles rated 7+ and below." },
  "13+": { label: "13+ · Teens", description: "Titles rated 13+ and below." },
  "16+": { label: "16+ · Older teens", description: "Titles rated 16+ and below." },
  "18+": { label: "18+ · Adults", description: "Every title, including mature content." },
};

export function maturityRank(level: MaturityLevel): number {
  return MATURITY_LEVELS.indexOf(level);
}

/** Kids profiles are capped at 7+ (the server enforces the same rule). */
export function clampForKids(level: MaturityLevel, isKids: boolean): MaturityLevel {
  return isKids && maturityRank(level) > maturityRank(KIDS_MATURITY_CEILING)
    ? KIDS_MATURITY_CEILING
    : level;
}

/** Raising a ceiling lets a profile see more: the server asks for the account password. */
export function raisesCeiling(from: MaturityLevel, to: MaturityLevel): boolean {
  return maturityRank(to) > maturityRank(from);
}

/** Subtitle languages offered as a profile default (BCP 47 tags). */
export const SUBTITLE_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "pl",
  "ru",
  "ja",
  "ko",
  "zh",
  "vi",
] as const;
