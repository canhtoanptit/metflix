/** Edits to wrangler.jsonc made by the tooling: surgical, keeping comments and layout. */
import { readFile, writeFile } from "node:fs/promises";
import { applyEdits, modify, parse } from "jsonc-parser";

interface ProductionIds {
  databaseId: string;
  /** KV namespace ids by binding (`CACHE`, `RECS`). */
  kv: Record<string, string>;
}

/**
 * Record the provisioned resource ids in `env.production` (they are not secrets: commit them).
 * Returns true when the file changed.
 */
export async function writeProductionIds(configPath: string, ids: ProductionIds): Promise<boolean> {
  const original = await readFile(configPath, "utf8");
  let text = original;
  const set = (path: (string | number)[], value: string) => {
    text = applyEdits(
      text,
      modify(text, ["env", "production", ...path], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  };
  const current = parse(text) as {
    env?: {
      production?: {
        d1_databases?: { database_id?: string }[];
        kv_namespaces?: { binding?: string; id?: string }[];
      };
    };
  };
  const production = current.env?.production;
  if (production?.d1_databases?.[0]?.database_id !== ids.databaseId) {
    set(["d1_databases", 0, "database_id"], ids.databaseId);
  }
  for (const [binding, id] of Object.entries(ids.kv)) {
    const index = production?.kv_namespaces?.findIndex((kv) => kv.binding === binding) ?? -1;
    if (index === -1) throw new Error(`env.production declares no KV binding ${binding}`);
    if (production?.kv_namespaces?.[index]?.id !== id) set(["kv_namespaces", index, "id"], id);
  }
  if (text === original) return false;
  await writeFile(configPath, text);
  return true;
}

export type ProductionRouting =
  | {
      ok: true;
      host: string;
      workersDev: boolean;
      routes: { pattern: string; custom_domain: true }[];
    }
  | { ok: false; reason: string };

/** Hosts reserved for documentation (RFC 2606): the shipped placeholder origin. */
const PLACEHOLDER_HOST = /(^|\.)example\.(com|org|net)$/;

/**
 * How production is reached, derived from the one origin users load (`WEBFLIX_PUBLIC_ORIGIN`):
 * a custom domain is the only hostname (`workers_dev: false`, a custom-domain route), so the
 * zone's WAF and rate-limiting rules cannot be bypassed through workers.dev; a
 * `*.workers.dev` origin (a first deploy without a domain) enables exactly that hostname.
 */
export function routingForOrigin(origin: string): ProductionRouting {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, reason: `WEBFLIX_PUBLIC_ORIGIN is not a URL: ${origin}` };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `WEBFLIX_PUBLIC_ORIGIN must be https in production: ${origin}` };
  }
  if (url.port || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, reason: `WEBFLIX_PUBLIC_ORIGIN must be a bare origin: ${origin}` };
  }
  const host = url.hostname;
  if (PLACEHOLDER_HOST.test(host)) {
    return {
      ok: false,
      reason:
        `WEBFLIX_PUBLIC_ORIGIN is still the placeholder (${origin}). Set env.production.vars.` +
        "WEBFLIX_PUBLIC_ORIGIN in apps/edge/wrangler.jsonc to your custom domain " +
        "(https://webflix.your-domain.com, on a zone in this account), or, for a first deploy " +
        "without one, to https://webflix.<your-subdomain>.workers.dev.",
    };
  }
  if (host.endsWith(".workers.dev")) return { ok: true, host, workersDev: true, routes: [] };
  return { ok: true, host, workersDev: false, routes: [{ pattern: host, custom_domain: true }] };
}

/** Write `workers_dev` and `routes` of env.production; true when the file changed. */
export async function writeProductionRouting(
  configPath: string,
  routing: Extract<ProductionRouting, { ok: true }>,
): Promise<boolean> {
  const original = await readFile(configPath, "utf8");
  let text = original;
  const set = (path: string[], value: unknown) => {
    text = applyEdits(
      text,
      modify(text, ["env", "production", ...path], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  };
  const production = (parse(text) as { env?: { production?: Record<string, unknown> } }).env
    ?.production;
  if (production?.workers_dev !== routing.workersDev) set(["workers_dev"], routing.workersDev);
  if (JSON.stringify(production?.routes ?? []) !== JSON.stringify(routing.routes)) {
    set(["routes"], routing.routes.length > 0 ? routing.routes : undefined);
  }
  if (text === original) return false;
  await writeFile(configPath, text);
  return true;
}
