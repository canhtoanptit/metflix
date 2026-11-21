/**
 * L2: whether the deploy may create the production media-token key, decided from what
 * `wrangler secret list` printed. Outputs are recorded in the shapes Wrangler 4.166 emits
 * (`secretListCommand` in wrangler-dist/cli.js); the last test pins that text.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideFirstKey,
  formatKeys,
  MEDIA_KEYS_SECRET,
  newKey,
  parseKeys,
  rotate,
} from "../../scripts/lib/media-keys.ts";

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string) => ({ code: 1, stdout: "", stderr });

describe("first-deploy media-token key", () => {
  it("keeps a key that is already set", () => {
    const listed = `[\n  {\n    "name": "${MEDIA_KEYS_SECRET}",\n    "type": "secret_text"\n  }\n]`;
    expect(decideFirstKey(ok(listed), "webflix")).toEqual({ action: "keep" });
  });

  it("creates one when the listing succeeded and shows none", () => {
    expect(decideFirstKey(ok("[]"), "webflix").action).toBe("create");
    expect(decideFirstKey(ok('[{"name":"OTHER","type":"secret_text"}]'), "webflix").action).toBe(
      "create",
    );
  });

  it("creates one when the Worker does not exist yet (first deploy)", () => {
    const missing = failed(
      '✘ [ERROR] Worker "webflix" (env: production) not found.\n\nIf this is a new Worker, run `wrangler deploy` first to create it.\nOtherwise, check that the Worker name is correct and you\'re logged into the right account.',
    );
    expect(decideFirstKey(missing, "webflix").action).toBe("create");
  });

  it("aborts on every other failure instead of replacing the key", () => {
    const failures = [
      failed(
        "✘ [ERROR] A request to the Cloudflare API (/accounts/0123/workers/scripts/webflix/secrets) failed.\n\n  Internal server error [code: 10013]",
      ),
      failed("✘ [ERROR] fetch failed\n\nCause: getaddrinfo ENOTFOUND api.cloudflare.com"),
      failed("✘ [ERROR] You are not authenticated. Please run `wrangler login`."),
      // Another Worker's "not found" (wrong name, wrong account) is not ours to create.
      failed('✘ [ERROR] Worker "webflix-staging" (env: production) not found.'),
      ok("Error: something unexpected"),
      ok('{"name":"not an array"}'),
    ];
    for (const output of failures) {
      expect(decideFirstKey(output, "webflix").action, output.stderr || output.stdout).toBe(
        "abort",
      );
    }
  });

  it("matches the installed Wrangler's wording for a missing Worker", async () => {
    const cli = await readFile(
      join(import.meta.dirname, "..", "..", "node_modules", "wrangler", "wrangler-dist", "cli.js"),
      "utf8",
    );
    const start = cli.indexOf("secretListCommand = createCommand(");
    const command = cli.slice(start, cli.indexOf("secretBulkCommand = createCommand(", start));
    // The template literal Wrangler builds the message from, as source text (`$` kept apart
    // so this file has no placeholder-looking strings).
    const $ = "$";
    const template = [
      'if (isWorkerNotFoundError(e)) throw new UserError$1(`Worker "',
      `${$}{scriptName}"`,
      `${$}{args.env ? \` (env: ${$}{args.env})\` : ""}`,
      " not found.",
    ].join("");
    expect(command).toContain(template);
  });
});

describe("two-phase key rotation", () => {
  const current = parseKeys(`k1:${"a".repeat(43)}`);
  const fresh = { id: "k2", secret: "b".repeat(43) };

  it("adds the new key verify-only, then promotes it, then retires the old one", () => {
    const added = rotate(current, "add", fresh);
    expect(added.map((key) => key.id)).toEqual(["k1", "k2"]); // k1 still signs
    const promoted = rotate(added, "promote");
    expect(promoted.map((key) => key.id)).toEqual(["k2", "k1"]); // k2 signs, k1 verifies
    expect(rotate(promoted, "retire").map((key) => key.id)).toEqual(["k2"]);
  });

  it("refuses steps out of order", () => {
    expect(() => rotate(current, "promote")).toThrow();
    expect(() => rotate(current, "retire")).toThrow();
    expect(() => rotate(rotate(current, "add", fresh), "add", newKey())).toThrow(/in progress/);
  });

  it("round-trips the secret format and rejects weak keys", () => {
    const key = newKey(new Date("2026-11-21T15:30:00Z"));
    expect(key.id).toBe("k202611211530");
    expect(parseKeys(formatKeys([key, fresh]))).toEqual([key, fresh]);
    expect(() => parseKeys("k1:short")).toThrow();
    expect(() => parseKeys(`k1:${"a".repeat(40)},k1:${"b".repeat(40)}`)).toThrow(/duplicate/);
  });
});
