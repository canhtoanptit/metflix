import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MailboxMessage } from "@webflix/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckFailure, fail } from "../src/expect.ts";
import { Agent } from "../src/http.ts";
import { linkToken } from "../src/mail.ts";
import { outcomeOf, parseIssuerForm } from "../src/oidc.ts";
import { parseCli } from "../src/options.ts";
import { runChecks } from "../src/runner.ts";
import { EventStream, uuidv7 } from "../src/telemetry.ts";
import type { CheckDefinition } from "../src/types.ts";

describe("issuer pages", () => {
  const page = `<main><form method="post" action="http://localhost:4000/dev-idp/google/authorize/select" data-dev-idp="sign-in">
<input type="hidden" name="txn" value="abc&amp;def">
<input type="radio" name="persona" value="new-member" checked>
</form>
<form method="post" action="http://localhost:4000/api/v1/auth/oidc/apple/callback" id="form-post" data-dev-idp="form-post">
<input type="hidden" name="code" value="c0de">
<input type="hidden" name="state" value="st&quot;ate">
</form></main>`;

  it("reads the sign-in form's action and hidden fields, unescaped", () => {
    const form = parseIssuerForm(page, "sign-in");
    expect(form?.action).toBe("http://localhost:4000/dev-idp/google/authorize/select");
    expect(form?.fields.get("txn")).toBe("abc&def");
    expect(form?.fields.has("persona")).toBe(false);
  });

  it("reads Apple's form post", () => {
    const form = parseIssuerForm(page, "form-post");
    expect(form?.action).toBe("http://localhost:4000/api/v1/auth/oidc/apple/callback");
    expect(Object.fromEntries(form?.fields ?? [])).toEqual({ code: "c0de", state: 'st"ate' });
  });

  it("returns null for a page without the form", () => {
    expect(parseIssuerForm("<h1>Error</h1>", "sign-in")).toBeNull();
  });
});

describe("emailed links", () => {
  const message = (links: string[]): MailboxMessage => ({
    id: "m1",
    to: "a@b.test",
    from: "Webflix <no-reply@webflix.dev>",
    subject: "Confirm",
    template: "verify-email",
    text: "",
    html: "",
    links,
    createdAt: "2026-11-22T10:00:00.000Z",
  });

  it("takes the token from the fragment", () => {
    expect(
      linkToken(message(["http://x.test/verify-email#token=abc_DEF-123"]), "/verify-email"),
    ).toBe("abc_DEF-123");
  });

  it("fails a token carried in the query string (it would reach servers and logs)", () => {
    expect(() =>
      linkToken(message(["http://x.test/verify-email?token=abc#token=abc"]), "/verify-email"),
    ).toThrow(CheckFailure);
  });

  it("fails a message without the link", () => {
    expect(() => linkToken(message(["http://x.test/account"]), "/verify-email")).toThrow(
      /no link to \/verify-email/,
    );
  });
});

describe("telemetry", () => {
  it("makes UUIDv7 ids in time order", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.slice(0, 13) < second.slice(0, 13)).toBe(true);
    expect(first.slice(0, 8)).toBe((1_700_000_000_000).toString(16).padStart(12, "0").slice(0, 8));
  });

  it("numbers a device's events like the SDK", () => {
    const stream = new EventStream("dev-1");
    const a = stream.event("title.open", { titleId: "t-sintel" });
    const b = stream.event("list.add", { titleId: "t-sintel" }, { surface: "my-list" });
    expect([a.sessionSeq, b.sessionSeq]).toEqual([1, 2]);
    expect(b.context.surface).toBe("my-list");
    expect(a.deviceId).toBe("dev-1");
    expect("subject" in a).toBe(false);
  });
});

describe("known findings", () => {
  const options = parseCli(["-u", "http://127.0.0.1:9", "--timeout", "1000"], {}).options;
  const finding = { id: "M2-FX", owner: "billing", summary: "the projection is wrong" };

  it("reports a failing check marked with a finding as XFAIL, carrying the finding", async () => {
    const checks: CheckDefinition[] = [
      {
        id: "f.fails",
        area: "billing",
        title: "",
        knownFinding: finding,
        run: async () => fail("wrong"),
      },
      { id: "f.fixed", area: "billing", title: "", knownFinding: finding, run: async () => {} },
    ];
    const report = await runChecks(checks, options);
    expect(report.results.map((result) => result.outcome)).toEqual(["xfail", "xpass"]);
    expect(report.results[0]?.finding).toEqual(finding);
    expect(report.ok).toBe(true);
  });
});

describe("the deployment's public origin", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/start") {
        // The deployment builds absolute URLs from its public origin (another port, same host).
        res.writeHead(302, { Location: "http://localhost:1/dev-idp/google/authorize?x=1" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("follows an aliased origin to the base URL, and refuses other hosts", async () => {
    const agent = new Agent({ baseUrl: base, label: "alias", runId: "t", requestTimeoutMs: 2_000 });
    expect(() => agent.alias("http://example.com")).toThrow(/another host/);
    const redirected = await agent.fetch("/start", { followRedirects: false });
    expect(redirected.status).toBe(302);
    expect(agent.ownPath(redirected.headers.get("Location") ?? "")).toBeNull();
    agent.alias("http://localhost:1");
    expect(agent.ownPath("http://localhost:1/dev-idp/google/authorize?x=1")).toBe(
      "/dev-idp/google/authorize?x=1",
    );
    const followed = await agent.fetch("/start");
    expect(followed.json()).toEqual({ path: "/dev-idp/google/authorize?x=1" });
  });

  it("reads the outcome of a callback redirect", async () => {
    const agent = new Agent({
      baseUrl: base,
      label: "outcome",
      runId: "t",
      requestTimeoutMs: 2_000,
    });
    const answer = await agent.fetch("/callback", { followRedirects: false });
    expect(outcomeOf(agent, answer)).toBeNull();
  });
});
