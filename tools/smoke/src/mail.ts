/**
 * The local mailbox (`GET /diagnostics/mailbox`, non-production): emails are sent by jobs, so
 * every read polls until the expected message has arrived.
 */
import type { MailboxMessage } from "@webflix/contracts";
import { check, succeeds } from "./expect.ts";
import type { Agent } from "./http.ts";
import type { CheckContext } from "./types.ts";

export type EmailTemplate = MailboxMessage["template"];

/** Messages of `template` for `to` (oldest first), polled until `count` are there. */
export async function awaitMail(
  ctx: CheckContext,
  agent: Agent,
  to: string,
  template: EmailTemplate,
  options: { count?: number; since?: string } = {},
): Promise<MailboxMessage[]> {
  const count = options.count ?? 1;
  const { value } = await ctx.eventually(`${count} "${template}" email(s) to ${to}`, async () => {
    const box = await succeeds(
      () =>
        agent.api.getMailbox({
          query: { to, ...(options.since === undefined ? {} : { since: options.since }) },
        }),
      "GET /diagnostics/mailbox",
    );
    const matching = box.items
      .filter((message) => message.template === template)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return matching.length >= count
      ? { done: true, value: matching }
      : {
          done: false,
          observed: `${matching.length} of ${count}; mailbox: ${box.items.map((message) => message.template).join(", ") || "empty"}`,
        };
  });
  return value;
}

/** Every message the mailbox holds for `to` right now (no waiting). */
export async function mailboxNow(agent: Agent, to: string): Promise<MailboxMessage[]> {
  const box = await succeeds(
    () => agent.api.getMailbox({ query: { to } }),
    "GET /diagnostics/mailbox",
  );
  return box.items;
}

/**
 * The single-use token of an emailed link to `path` (`/verify-email`, `/reset-password`). The
 * design puts it in the URL fragment, which a browser never sends to a server (§4.3; logs,
 * referrers and proxies never see it): a token in the query string fails the check.
 */
export function linkToken(message: MailboxMessage, path: string): string {
  const link = message.links.find((candidate) => {
    try {
      return new URL(candidate).pathname === path;
    } catch {
      return false;
    }
  });
  check(link, `the "${message.template}" email has no link to ${path}`, {
    observed: message.links.join(", ") || "(no links)",
  });
  const url = new URL(link);
  check(!url.searchParams.has("token"), `the ${path} link carries its token in the query string`, {
    expected: `${path}#token=… (the fragment never reaches a server)`,
    observed: link,
  });
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  check(token, `the ${path} link has no #token= fragment`, { observed: link });
  return token;
}
