import { describe, expect, it } from "vitest";
import { parseReadyLine, parseSigningSecret } from "../src/listen.ts";
import { paths } from "../src/paths.ts";
import { isSandboxState, renderEnvFile, type SandboxState } from "../src/state.ts";
import { CLI_PROJECT_NAME, isolatedEnv, profileArgs } from "../src/stripe-cli.ts";
import { fake } from "./fakes.ts";

describe("stripe listen output", () => {
  it("extracts the signing secret from --print-secret", () => {
    expect(parseSigningSecret(`${fake.webhookSecret}\n`)).toBe(fake.webhookSecret);
    expect(parseSigningSecret("Error: something failed")).toBeNull();
  });

  it("detects readiness and the API version events are rendered in", () => {
    const log = `Getting ready...\nReady! You are using Stripe API Version [2026-11-18.endive]. Your webhook signing secret is ${fake.webhookSecret} (^C to quit)\n`;
    expect(parseReadyLine(log)).toEqual({ ready: true, apiVersion: "2026-11-18.endive" });
    expect(parseReadyLine("Getting ready...")).toEqual({ ready: false, apiVersion: null });
  });
});

describe("CLI isolation", () => {
  it("never passes the caller's Stripe or XDG settings through", () => {
    const saved = { ...process.env };
    process.env.STRIPE_API_KEY = fake.secretKey;
    process.env.XDG_CONFIG_HOME = "/somewhere/else";
    process.env.STRIPE_PROJECT_NAME = "default";
    try {
      const env = isolatedEnv();
      expect(env.STRIPE_API_KEY).toBeUndefined();
      expect(env.STRIPE_PROJECT_NAME).toBeUndefined();
      expect(env.XDG_CONFIG_HOME).toBe(paths.cliXdgConfigHome);
      expect(env.HOME).toBe(paths.cliHome);
      expect(env.STRIPE_NO_UPDATE_CHECK).toBe("1");
      expect(env.STRIPE_CLI_TELEMETRY_OPTOUT).toBe("1");
      expect(Object.values(env).join("\n")).not.toContain(fake.secretKey);
    } finally {
      process.env = saved;
    }
  });

  it("points the CLI at the repository-local profile, never `default`", () => {
    const args = profileArgs();
    expect(args).toContain(paths.cliConfigFile);
    expect(CLI_PROJECT_NAME).not.toBe("default");
    expect(args.join(" ")).toContain(`--project-name ${CLI_PROJECT_NAME}`);
    expect(paths.cliConfigFile.startsWith(paths.cache)).toBe(true);
    expect(paths.cache).toMatch(/\/\.cache\/stripe$/);
  });
});

describe("state files", () => {
  const state: SandboxState = {
    schema: 1,
    accountId: "acct_1AbCDE7xQm2LpRt9",
    secretKey: fake.sandboxKey,
    publishableKey: fake.publishableKey,
    claimUrl: fake.claimUrl,
    expiresOn: "2026-11-28",
    createdAt: "2026-11-21T17:57:50.000Z",
    cliVersion: "1.55.14",
    webhookSecret: fake.webhookSecret,
    webhookSecretCapturedAt: "2026-11-21T17:59:03.000Z",
  };

  it("validates the JSON shape", () => {
    expect(isSandboxState(state)).toBe(true);
    expect(isSandboxState({ ...state, schema: 2 })).toBe(false);
    expect(isSandboxState({ ...state, secretKey: undefined })).toBe(false);
  });

  it("renders a dotenv file without the claim link", () => {
    const env = renderEnvFile(state);
    expect(env).toContain(`STRIPE_SECRET_KEY=${fake.sandboxKey}`);
    expect(env).toContain(`STRIPE_WEBHOOK_SECRET=${fake.webhookSecret}`);
    expect(env).toContain("STRIPE_SANDBOX_EXPIRES_ON=2026-11-28");
    expect(env).not.toContain(fake.claimUrl);
  });
});
