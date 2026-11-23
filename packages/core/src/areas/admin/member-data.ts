/**
 * The admin area's part of a member's rights (milestone 2 §6.3; privacy review M5, M6), run by
 * the events area's erasure and export jobs through the `AreaModule` hooks.
 *
 * - Erasure: the audit trail keeps which staff member did what and when, and nothing that
 *   identifies the member: entries about them get an erased marker as their target, lose
 *   `before`, `after` (but the error code) and the free-text reason; any other entry that
 *   mentions the account id, its address, its profiles' or privacy requests' ids has each
 *   replaced by the marker; dead letters that mention them are deleted (their payloads are
 *   raw jobs). Idempotent: a retry after the account row is gone still scrubs the account id.
 * - Export: the record of staff access to the account, as date and action only: no staff
 *   identity, no reason, no detail.
 */
import type { JsonValue } from "@webflix/contracts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { AreaServices } from "../index.ts";

/** Entries about one member read for its export, at most (the retention period bounds them). */
const EXPORT_LIMIT = 5000;
const EXPORT_PAGE = 100;

export function createMemberData(deps: ServiceDependencies, areas: () => AreaServices) {
  const log = deps.logger.child({ component: "admin.member_data" });

  return {
    async eraseAccountData(accountId: string): Promise<void> {
      const { identity, events } = areas();
      const member = await identity.getMemberIdentity(accountId).catch((error: unknown) => {
        // A retry after the account row went: the id is still known, the address is not.
        if (error instanceof AppError && error.code === "not_found") return null;
        throw error;
      });
      const requests = await events.staff.privacyRequests(accountId);
      const identifiers = [
        accountId,
        ...(member ? [member.account.email, ...member.profiles.map((profile) => profile.id)] : []),
        ...requests.map((request) => request.id),
      ];
      const marker = `erased:${deps.ids.next()}`;
      const entries = await deps.repos.admin.eraseAuditSubject({
        target: { type: "member", id: accountId },
        identifiers,
        marker,
      });
      const deadLetters = await deps.repos.admin.deleteDeadLettersMentioning(identifiers);
      // Counts only: the log line must not carry what was just erased.
      log.info("admin.member_erased", { auditEntries: entries, deadLetters });
    },

    async exportAccountData(accountId: string): Promise<JsonValue> {
      const access: { at: string; action: string }[] = [];
      let before: { createdAt: number; id: string } | null = null;
      while (access.length < EXPORT_LIMIT) {
        const rows = await deps.repos.admin.listAudit(
          { targetType: "member", targetId: accountId },
          { before, limit: EXPORT_PAGE },
        );
        for (const row of rows) access.push({ at: toIsoString(row.createdAt), action: row.action });
        const last = rows.at(-1);
        if (!last || rows.length < EXPORT_PAGE) break;
        before = { createdAt: last.createdAt, id: last.id };
      }
      // Oldest first, as the member reads a history; who acted and why stay with Webflix.
      return { staffAccess: access.reverse() };
    },
  };
}
