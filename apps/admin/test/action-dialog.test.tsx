/** The action dialog's promises: one send at a time, keys per intention, honest endings. */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, ERROR_CATALOG, type ErrorCode } from "@webflix/contracts";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The dialog links to the audit entry; a plain anchor stands in for the router's Link here.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => <a href={`${to}?${new URLSearchParams(search ?? {}).toString()}`}>{children}</a>,
}));

import { StaffProvider } from "../src/access/staff.tsx";
import { ActionDialog, type RunContext } from "../src/components/ActionDialog.tsx";
import { resetAttempts } from "../src/components/attempts.ts";

beforeEach(() => resetAttempts());

function Harness({
  run,
  idempotent = true,
}: {
  run: (context: RunContext) => Promise<string>;
  idempotent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <StaffProvider
      identity={{ subject: "s1", name: "Sam", email: null, roles: ["support", "billing"] }}
    >
      <button type="button" onClick={() => setOpen(true)}>
        Open refund
      </button>
      <ActionDialog<string>
        open={open}
        onOpenChange={setOpen}
        scope="refund:a1:i1"
        title="Refund invoice 7"
        confirmLabel="Refund $4.00"
        idempotent={idempotent}
        run={run}
        success={(result) => `Refunded (${result}).`}
        audit={{ targetType: "member", targetId: "a1" }}
      />
    </StaffProvider>
  );
}

async function openAndFill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open refund" }));
  await user.type(screen.getByLabelText(/Reason/), "Goodwill refund");
}

const apiError = (code: ErrorCode, extra: Record<string, unknown> = {}) =>
  new ApiError({
    type: `urn:webflix:problem:${code}`,
    title: ERROR_CATALOG[code].title,
    status: ERROR_CATALOG[code].status,
    code,
    ...extra,
  } as unknown as ConstructorParameters<typeof ApiError>[0]);

describe("ActionDialog", () => {
  it("asks why before sending anything", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async () => "r1");
    render(<Harness run={run} />);
    await user.click(screen.getByRole("button", { name: "Open refund" }));
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    expect(screen.getByText(/Say why, in a few words/)).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    await expectNoA11yViolations(document.body);
  });

  it("sends once however often the button is pressed, with the request named", async () => {
    const user = userEvent.setup();
    let resolve: (value: string) => void = () => undefined;
    const run = vi.fn((_context: RunContext) => new Promise<string>((done) => (resolve = done)));
    render(<Harness run={run} />);
    await openAndFill(user);
    const confirm = screen.getByRole("button", { name: "Refund $4.00" });
    await user.click(confirm);
    await user.click(confirm);
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => resolve("ref-1"));
    expect(await screen.findByText("Refunded (ref-1).")).toBeInTheDocument();
  });

  it("after a refusal, nothing changed, and the corrected form is a new intention (new key)", async () => {
    const user = userEvent.setup();
    const run = vi
      .fn<(context: RunContext) => Promise<string>>()
      .mockRejectedValueOnce(apiError("checkout_state_conflict", { detail: "Nothing to refund." }))
      .mockResolvedValueOnce("ref-2");
    render(<Harness run={run} />);
    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was changed.");
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    await screen.findByText("Refunded (ref-2).");
    const [first, second] = run.mock.calls.map(([context]) => context.idempotencyKey);
    expect(second).not.toBe(first);
  });

  it("no answer: checking again re-sends the same key and shows the first answer", async () => {
    const user = userEvent.setup();
    const run = vi
      .fn<(context: RunContext) => Promise<string>>()
      .mockRejectedValueOnce(
        new ApiError({ type: "x", title: "x", status: 0, code: "network_error" }),
      )
      .mockResolvedValueOnce("ref-3");
    render(<Harness run={run} />);
    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    expect(await screen.findByRole("heading", { name: "No answer from the server" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Refunded (ref-3).");
    const [first, second] = run.mock.calls.map(([context]) => context.idempotencyKey);
    expect(second).toBe(first);
  });

  it("an unknown outcome offers no second attempt and is still there after closing", async () => {
    const user = userEvent.setup();
    const run = vi.fn(async (_context: RunContext): Promise<string> => {
      throw apiError("service_unavailable", {
        detail: "The payment provider is not answering. Try again.",
      });
    });
    render(<Harness run={run} />);
    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    await screen.findByRole("heading", { name: "Outcome unknown" });
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    // Without the admin role the way on is "your actions", at the entry this request wrote.
    const firstRequest = run.mock.calls[0]?.[0].headers["X-Request-Id"] ?? "";
    expect(screen.getByRole("link", { name: "Open it in your actions" })).toHaveAttribute(
      "href",
      `/activity?requestId=${firstRequest}`,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Open refund" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Open refund" }));
    expect(await screen.findByRole("heading", { name: "Outcome unknown" })).toBeInTheDocument();
    const firstKey = run.mock.calls[0]?.[0].idempotencyKey;
    await user.click(screen.getByRole("button", { name: "Start a new attempt" }));
    await user.type(screen.getByLabelText(/Reason/), "Checked: it didn't happen");
    await user.click(screen.getByRole("button", { name: "Refund $4.00" }));
    await screen.findByRole("heading", { name: "Outcome unknown" });
    expect(run.mock.calls[1]?.[0].idempotencyKey).not.toBe(firstKey);
  });
});
