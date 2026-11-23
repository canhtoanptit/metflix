/**
 * Imported first by the entry. zod (in the chunks that validate a document before sending it)
 * probes `new Function("")` when it loads, to decide whether it may compile validators; the
 * console's Content-Security-Policy (script-src 'self', no 'unsafe-eval') refuses it and the
 * browser reports a violation, though zod swallows the error. With `jitless` zod never tries.
 * zod reads this global when it loads, so it must be set before any chunk with zod runs.
 */
const scope = globalThis as { __zod_globalConfig?: Record<string, unknown> };
scope.__zod_globalConfig = { ...scope.__zod_globalConfig, jitless: true };

export {};
