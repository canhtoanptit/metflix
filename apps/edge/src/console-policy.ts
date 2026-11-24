/**
 * The staff console's Content-Security-Policy (no imports: the Worker and the asset staging in
 * scripts/lib/assets.ts both use it, so the console's files and its client-side routes carry the
 * same policy).
 *
 * The console shares the member app's origin but not its policy: the member app connects to any
 * https origin (external HLS fallbacks) and, with Stripe, loads Stripe.js and Google Maps; the
 * console loads only its own files and connects only to this origin (the staff API, and the
 * development issuer outside production) and to the configured staff issuer, whose discovery
 * document and token endpoint it fetches. Signing in and out are navigations, which a CSP does
 * not govern. No frames, workers, media or plugins.
 */

/** The issuer's origin when it is another origin; null for a path on this origin, or none. */
export function issuerOrigin(issuer: string | null): string | null {
  if (!issuer || issuer.startsWith("/")) return null;
  try {
    return new URL(issuer).origin;
  } catch {
    return null;
  }
}

export function consoleContentSecurityPolicy(issuer: string | null): string {
  const origin = issuerOrigin(issuer);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self'${origin ? ` ${origin}` : ""}`,
    "manifest-src 'self'",
    "media-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
