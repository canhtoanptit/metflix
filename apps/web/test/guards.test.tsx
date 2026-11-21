import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { locationOf, renderApp } from "./harness.tsx";

async function landAt(path: string, scenario: Parameters<typeof renderApp>[1]) {
  const app = renderApp(path, scenario);
  await waitFor(() => expect(app.router.state.status).toBe("idle"), { timeout: 5000 });
  return app;
}

describe("route guards", () => {
  describe("signed out → marketing and auth", () => {
    it.each([
      ["/browse", "/login?redirect=%2Fbrowse"],
      ["/my-list", "/login?redirect=%2Fmy-list"],
      ["/watch/t-sintel", "/login?redirect=%2Fwatch%2Ft-sintel"],
      ["/profiles", "/login?redirect=%2Fprofiles"],
      ["/account", "/login?redirect=%2Faccount"],
    ])("%s redirects to %s", async (path, expected) => {
      const { router } = await landAt(path, "anonymous");
      expect(locationOf(router)).toBe(expected);
    });

    it("shows the landing page and sign-in to guests", async () => {
      const { router } = await landAt("/", "anonymous");
      expect(locationOf(router)).toBe("/");
      expect(
        await screen.findByRole("heading", { name: "Stories that stay with you." }),
      ).toBeInTheDocument();
    });

    it("drops unsafe redirect targets", async () => {
      const { router } = await landAt("/login?redirect=%2F%2Fevil.example", "anonymous");
      // The raw URL keeps it, but the validated search the screen reads does not.
      expect(router.state.matches.at(-1)?.search).toMatchObject({ redirect: undefined });
    });
  });

  describe("signed in without a profile → profile gate", () => {
    it.each([
      ["/browse", "/profiles?redirect=%2Fbrowse"],
      ["/search?q=moon", "/profiles?redirect=%2Fsearch%3Fq%3Dmoon"],
      ["/account/activity", "/profiles?redirect=%2Faccount%2Factivity"],
      ["/", "/profiles"],
      ["/login", "/profiles"],
    ])("%s redirects to %s", async (path, expected) => {
      const { router } = await landAt(path, "account");
      expect(locationOf(router)).toBe(expected);
    });

    it("renders the gate; account pages ask for a profile first", async () => {
      await landAt("/profiles", "account");
      expect(await screen.findByRole("heading", { name: "Who's watching?" })).toBeInTheDocument();
      const account = await landAt("/account", "account");
      expect(locationOf(account.router)).toBe("/profiles?redirect=%2Faccount");
    });
  });

  describe("signed in with a profile → the app", () => {
    it.each([
      ["/", "/browse"],
      ["/login", "/browse"],
      ["/title/t-sintel", "/browse?title=t-sintel"],
    ])("%s redirects to %s", async (path, expected) => {
      const { router } = await landAt(path, "profile");
      expect(locationOf(router)).toBe(expected);
    });

    it("renders browse and keeps the profile gate reachable for switching", async () => {
      await landAt("/browse", "profile");
      expect(
        await screen.findByRole("region", { name: /Continue Watching for Mara/ }),
      ).toBeInTheDocument();
      expect(document.title).toBe("Home · Webflix");
      const gate = await landAt("/profiles", "profile");
      expect(locationOf(gate.router)).toBe("/profiles");
    });
  });

  it("selecting a profile on the gate continues to the original destination", async () => {
    const { router } = await landAt("/browse", "account");
    expect(locationOf(router)).toBe("/profiles?redirect=%2Fbrowse");
    (await screen.findByRole("button", { name: /^Mara/ })).click();
    await waitFor(() => expect(locationOf(router)).toBe("/browse"), { timeout: 5000 });
  });

  it("renders a not-found page for unknown URLs", async () => {
    await landAt("/no/such/page", "anonymous");
    expect(await screen.findByRole("heading", { name: "Lost your way?" })).toBeInTheDocument();
    expect(document.title).toBe("Page not found · Webflix");
  });
});
