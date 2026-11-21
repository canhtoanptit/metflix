// Types for `ctx.exports` / `import { exports } from "cloudflare:workers"`: the loopback
// bindings for this Worker's own entrypoints and Durable Object classes.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces: "RateLimiterObject" | "StreamGateObject";
  }
}
