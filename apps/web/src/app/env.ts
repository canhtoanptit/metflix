/**
 * Build-time mode flags, injected by Vite `define` (see vite.config.ts) and replaced textually
 * wherever they appear, so the minifier deletes the dead branch and everything it imports.
 * Use the globals directly at the branch: re-exporting them as constants from a module would
 * defeat that (bundlers do not fold constants across modules).
 *
 * - `__WEBFLIX_MOCK__`: `vite --mode mock`; the API is answered in the browser.
 * - `__WEBFLIX_DEVTOOLS__`: dev server or mock build; enables /dev/reference and the dev toolbar.
 */
declare global {
  const __WEBFLIX_MOCK__: boolean;
  const __WEBFLIX_DEVTOOLS__: boolean;
}

export {};
