/** Dialects every repository supports; the repository contract suite runs against each. */
export const SQL_DIALECTS = ["postgres", "sqlite", "d1"] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

/** D1's cap on bound parameters per statement (https://developers.cloudflare.com/d1/platform/limits/). */
export const MAX_BOUND_PARAMETERS = 100;
