/**
 * How much of the host a Playwright run may take; both configs use these (README "Host guard").
 *
 * On 2026-11-22 a full run at Playwright's defaults (half the cores: nine workers, each with its
 * browsers) recorded a video of every test, which kept nine video encoders busy next to dozens of
 * headless browsers. On a host already deep in swap, that ran the Mac out of memory.
 *
 *   E2E_WORKERS=<n>  workers (default 4)
 *   E2E_VIDEO=1      keep a video of each failing test, while a failure is being investigated
 */
const requested = Number(process.env.E2E_WORKERS);
export const workers = Number.isInteger(requested) && requested > 0 ? requested : 4;

const videoWanted = Boolean(process.env.E2E_VIDEO) && process.env.E2E_VIDEO !== "0";
export const video = videoWanted ? ("retain-on-failure" as const) : ("off" as const);
