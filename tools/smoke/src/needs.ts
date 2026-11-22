/**
 * What a check needs from the target. Each requirement is detected from the outside (never
 * assumed from the mode name); an unmet one skips the check with the reason.
 */
import { measureProfilePinLimit } from "./limits.ts";
import type { Requirement } from "./types.ts";

export const needs = {
  webBuild: {
    id: "web-build",
    async evaluate(env) {
      const fact = await env.webBuild();
      return fact.served
        ? null
        : `no web build is served at this URL (${fact.evidence}); API-only target`;
    },
  },
  packagedMedia: {
    id: "packaged-media",
    async evaluate(env) {
      const discovery = await env.media();
      return discovery.packaged
        ? null
        : `no title plays packaged media (probed ${discovery.probed.length}: all external HLS fallback or unavailable); run tools/media and upload to this deployment`;
    },
  },
  externalMedia: {
    id: "external-media",
    async evaluate(env) {
      const discovery = await env.media();
      return discovery.external
        ? null
        : `no title plays the external HLS fallback (probed ${discovery.probed.length}, all packaged)`;
    },
  },
  demo: {
    id: "demo-account",
    async evaluate(env) {
      const fact = await env.demo();
      return fact.available ? null : fact.reason;
    },
  },
  ipExhaustion: {
    id: "ip-exhaustion-allowed",
    async evaluate(env) {
      return env.options.allowIpExhaustion
        ? null
        : "exhausting IP-keyed limits is disabled (--no-ip-exhaustion)";
    },
  },
  googleIssuer: {
    id: "dev-issuer-google",
    async evaluate(env) {
      const fact = await env.memberIssuer("google");
      return fact.available ? null : fact.reason;
    },
  },
  appleIssuer: {
    id: "dev-issuer-apple",
    async evaluate(env) {
      const fact = await env.memberIssuer("apple");
      return fact.available ? null : fact.reason;
    },
  },
  mailbox: {
    id: "mailbox",
    async evaluate(env) {
      const fact = await env.mailbox();
      return fact.available ? null : fact.reason;
    },
  },
  fakePayments: {
    id: "fake-payments",
    async evaluate(env) {
      const fact = await env.payments();
      return fact.available ? null : fact.reason;
    },
  },
  staffIssuer: {
    id: "staff-issuer",
    async evaluate(env) {
      const fact = await env.staffIssuer();
      return fact.available ? null : fact.reason;
    },
  },
  strictLimits: {
    id: "strict-rate-limits",
    async evaluate(env) {
      if (env.options.rateLimits.mode === "strict") return null;
      if (env.options.rateLimits.mode !== "auto") {
        return `--rate-limits ${env.options.rateLimits.mode}: the documented strict defaults do not apply`;
      }
      const measured = await measureProfilePinLimit(env);
      if (measured.classification === "strict") return null;
      return measured.classification === "relaxed"
        ? `the target runs relaxed limits (profile-pin burst admitted ${measured.allowed}, dev mode's documented 60/min), so the strict defaults do not apply`
        : `the target's limits are neither documented profile (profile-pin burst admitted ${measured.allowed}; ${measured.verdict})`;
    },
  },
} satisfies Record<string, Requirement>;
