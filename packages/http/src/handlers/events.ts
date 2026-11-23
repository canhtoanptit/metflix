import type { AppContainer } from "../container.ts";
import { enforceRateLimit, requireAccount, requireAccountHolder, resolveAuth } from "../session.ts";
import type { AppContext, AreaHandlers } from "./types.ts";

/** `Sec-GPC: 1` (Global Privacy Control): honoured as a withdrawal (docs/BLUEPRINT-M2.md §6.3). */
function globalPrivacyControl(c: AppContext): boolean {
  return c.req.header("Sec-GPC")?.trim() === "1";
}

/**
 * The visitor's country, only from the platform: Workers' `request.cf.country` cannot be forged
 * by the client (a header could), so the Node runtime stamps none. `XX` (unknown) and `T1`
 * (Tor) are not countries.
 */
function platformCountry(c: AppContext): string | null {
  const cf = (c.req.raw as { cf?: { country?: unknown } }).cf;
  const country = typeof cf?.country === "string" ? cf.country : null;
  return country && /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null;
}

/**
 * The events area's routes (milestone 2 §6): behaviour events, consent, data export, account
 * deletion and the events read-back for the suites. Thin mappings onto `services.events`.
 */
export function createEventsHandlers(container: AppContainer): AreaHandlers<"events"> {
  const { services } = container;
  const holder = (c: AppContext) => requireAccountHolder(container, c);

  return {
    ingestEvents: async ({ body }, c) => {
      const auth = await resolveAuth(container, c);
      // Two budgets of the `events` policy: per account (signed out: per client address, the
      // policy's default key) and per device, so neither one device nor one member can flood.
      await enforceRateLimit(
        container,
        c,
        "events",
        auth ? `account:${auth.session.accountId}` : undefined,
      );
      const deviceId = body.events[0]?.deviceId;
      if (deviceId) await enforceRateLimit(container, c, "events", `device:${deviceId}`);
      return services.events.ingest({
        auth,
        events: body.events,
        consent: body.consent,
        gpc: globalPrivacyControl(c),
        country: platformCountry(c),
      });
    },

    getConsent: async (_request, c) =>
      services.events.getConsent(await resolveAuth(container, c), {
        gpc: globalPrivacyControl(c),
      }),

    updateConsent: async ({ body }, c) =>
      services.events.updateConsent(await requireAccount(container, c), body, {
        gpc: globalPrivacyControl(c),
      }),

    requestDataExport: async (_request, c) => services.events.requestExport(await holder(c)),

    downloadDataExport: async ({ params, query }, c) => {
      const document = await services.events.downloadExport(
        await holder(c),
        params.id,
        query.token,
      );
      c.header("Content-Disposition", `attachment; filename="webflix-data-${params.id}.json"`);
      return document;
    },

    fetchDataExport: async ({ params, body }, c) => {
      const document = await services.events.downloadExport(await holder(c), params.id, body.token);
      c.header("Content-Disposition", `attachment; filename="webflix-data-${params.id}.json"`);
      return document;
    },

    listPrivacyRequests: async (_request, c) =>
      services.events.listPrivacyRequests(await holder(c)),

    requestAccountDeletion: async (_request, c) => services.events.requestDeletion(await holder(c)),

    cancelAccountDeletion: async (_request, c) => services.events.cancelDeletion(await holder(c)),

    getRecentEvents: async ({ query }, c) =>
      services.events.recentEvents(await requireAccount(container, c), query),
  };
}
