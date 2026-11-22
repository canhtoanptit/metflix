// Bindings declared in vitest.config.ts (miniflare options of the workerd project).
declare namespace Cloudflare {
  interface Env {
    STRIPE_SECRET_KEY?: string;
    STRIPE_PUBLISHABLE_KEY?: string;
  }
}
