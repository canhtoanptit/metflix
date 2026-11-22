import type { Environment } from "../config.ts";

/** What an area's configuration loader sees: the non-empty string variables of the env. */
export interface AreaConfigInput {
  vars: Readonly<Record<string, string>>;
  environment: Environment;
}

/** A loaded area configuration, or every problem with it (reported with all the others). */
export interface AreaConfigResult<T> {
  config: T;
  issues: string[];
}

/** One of `allowed`, or `fallback` when unset; an issue otherwise. */
export function choice<const T extends readonly string[]>(
  input: AreaConfigInput,
  name: string,
  allowed: T,
  fallback: T[number],
  issues: string[],
): T[number] {
  const value = input.vars[name];
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value;
  issues.push(`${name}: expected one of ${allowed.join(", ")}`);
  return fallback;
}

/** A positive whole number, or `fallback` when unset; an issue otherwise. */
export function positiveInteger(
  input: AreaConfigInput,
  name: string,
  fallback: number,
  issues: string[],
): number {
  const value = input.vars[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  issues.push(`${name}: expected a positive whole number`);
  return fallback;
}

/** A secret of at least `minLength` characters, or null when unset; an issue when too short. */
export function secret(
  input: AreaConfigInput,
  name: string,
  minLength: number,
  issues: string[],
): string | null {
  const value = input.vars[name];
  if (value === undefined) return null;
  if (value.length >= minLength) return value;
  issues.push(`${name}: must be at least ${minLength} characters`);
  return null;
}
