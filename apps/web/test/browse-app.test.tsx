import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@webflix/ui";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { previewStore } from "../src/features/browse/preview/store.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState } from "../src/mocks/state.ts";
import { locationOf } from "./harness.tsx";

/** The real app over the in-browser mock, signed in as Mara, optionally with failing routes. */
function renderBrowse(path: string, failing: string[] = []) {
  const apiClient = createMockApiClient({
    state: initialState("profile"),
    settings: { latencyMs: 0, failing },
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(apiClient, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime, history };
}

afterEach(() => {
  previewStore.reset();
  act(() => toast.reset());
});

describe("navigation search", () => {
  it("expands, puts typing in the URL after a pause (one history entry), and keeps focus", async () => {
    const user = userEvent.setup();
    const { router, history } = renderBrowse("/browse");
    await user.click(await screen.findByRole("button", { name: "Search" }, { timeout: 5000 }));
    const field = screen.getByRole("searchbox", { name: "Search titles, people and genres" });
    expect(field).toHaveFocus();
    const entries = history.length;

    await user.type(field, "sin");
    // Typing is instant in the field; the URL waits for the pause.
    expect(field).toHaveValue("sin");
    await waitFor(() => expect(locationOf(router)).toBe("/search?q=sin"));
    await user.type(field, "tel");
    await waitFor(() => expect(locationOf(router)).toBe("/search?q=sintel"));
    expect(history.length).toBe(entries + 1);
    expect(field).toHaveFocus();
    expect(await screen.findByRole("list", { name: "Results for sintel" })).toBeInTheDocument();
  });

  it("clearing returns to where you were; Escape on an empty field folds it away", async () => {
    const user = userEvent.setup();
    const { router } = renderBrowse("/browse");
    await user.click(await screen.findByRole("button", { name: "Search" }, { timeout: 5000 }));
    const field = screen.getByRole("searchbox");
    await user.type(field, "moon");
    await waitFor(() => expect(locationOf(router)).toBe("/search?q=moon"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(locationOf(router)).toBe("/browse"));
    expect(field).toHaveFocus();
    expect(field).toHaveValue("");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("searchbox")).toBeNull());
  });
});

describe("library actions", () => {
  it("adds to My List optimistically from the detail overlay", async () => {
    const user = userEvent.setup();
    renderBrowse("/browse?title=t-kilometer-zero");
    const dialog = await screen.findByRole("dialog", { name: "Kilometer Zero" }, { timeout: 5000 });
    const add = await within(dialog).findByRole("button", {
      name: "Add Kilometer Zero to My List",
    });
    await user.click(add);
    expect(
      within(dialog).getByRole("button", { name: "Remove Kilometer Zero from My List" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("rolls back and says so when adding fails", async () => {
    const user = userEvent.setup();
    renderBrowse("/browse?title=t-kilometer-zero", ["addToMyList"]);
    const dialog = await screen.findByRole("dialog", { name: "Kilometer Zero" }, { timeout: 5000 });
    await user.click(
      await within(dialog).findByRole("button", { name: "Add Kilometer Zero to My List" }),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Add Kilometer Zero to My List" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByText("Couldn't add to My List")).toBeInTheDocument();
  });

  it("rates from the keyboard: open the choices, move with arrows, choose, focus returns", async () => {
    const user = userEvent.setup();
    renderBrowse("/browse?title=t-kilometer-zero");
    const dialog = await screen.findByRole("dialog", { name: "Kilometer Zero" }, { timeout: 5000 });
    const trigger = await within(dialog).findByRole("button", { name: "Rate Kilometer Zero" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const choices = await within(dialog).findByRole("group", { name: "Rate Kilometer Zero" });
    await waitFor(() =>
      expect(within(choices).getByRole("button", { name: "I like this" })).toHaveFocus(),
    );
    await user.keyboard("{ArrowRight}");
    expect(within(choices).getByRole("button", { name: "Love this!" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const rated = await within(dialog).findByRole(
      "button",
      { name: /^Rated Love this!/ },
      { timeout: 2000 },
    );
    await waitFor(() => expect(rated).toHaveFocus());
    // Escape inside the choices closes them, not the overlay.
    await user.keyboard("{Enter}");
    await within(dialog).findByRole("group", { name: "Rate Kilometer Zero" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(within(dialog).queryByRole("group", { name: "Rate Kilometer Zero" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Kilometer Zero" })).toBeInTheDocument();
  });
});

describe("hover preview", () => {
  it("opens on hover intent and removes a title from Continue Watching", async () => {
    const user = userEvent.setup();
    renderBrowse("/browse");
    const row = await screen.findByRole(
      "region",
      { name: /Continue Watching for Mara/ },
      { timeout: 5000 },
    );
    const cards = within(row).getAllByRole("link");
    const first = cards[0];
    if (!first) throw new Error("no card");
    const name = first.textContent ?? "";
    await user.hover(first.closest("li") ?? first);
    // Nothing before the intent delay…
    expect(screen.queryByTestId("hover-preview")).toBeNull();
    // …then the preview, with the title's actions.
    const preview = await screen.findByTestId("hover-preview", {}, { timeout: 2000 });
    const remove = await within(preview).findByRole("button", { name: /from Continue Watching$/ });
    await user.click(remove);
    await waitFor(() => expect(screen.queryByTestId("hover-preview")).toBeNull());
    await waitFor(() =>
      expect(
        within(row)
          .queryAllByRole("link")
          .map((link) => link.textContent),
      ).not.toContain(name),
    );
    expect(await screen.findByText("Removed from Continue Watching")).toBeInTheDocument();
  });
});
