import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { locationOf, renderApp } from "./harness.tsx";

describe("title detail overlay (URL-driven)", () => {
  it("opens from a card via ?title=, keeps the page, and Escape goes back", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/browse", "profile");
    const row = await screen.findByRole("region", { name: "Trending Now" }, { timeout: 5000 });
    const firstCard = within(row).getAllByRole("link")[0];
    if (!firstCard) throw new Error("no card");
    await user.click(firstCard);

    await waitFor(() => expect(router.state.location.search).toHaveProperty("title"));
    expect(router.state.location.pathname).toBe("/browse");
    expect(router.state.location.state.titleOverlay).toBe(true);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("link", { name: "Play" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(locationOf(router)).toBe("/browse"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a shared link opens the overlay and closing replaces the URL", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/title/t-sintel", "profile");
    const dialog = await screen.findByRole("dialog", { name: "Sintel" }, { timeout: 5000 });
    expect(locationOf(router)).toBe("/browse?title=t-sintel");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(locationOf(router)).toBe("/browse"));
    expect(document.title).toBe("Home · Webflix");
  });
});
