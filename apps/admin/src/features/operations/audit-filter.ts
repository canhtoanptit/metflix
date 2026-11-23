/** An audit-log filter for a target, never carrying a member search's query (personal data). */
export function auditFilterFor(target: { type: string; id: string }): {
  targetType: string;
  targetId?: string;
} {
  return target.type === "member_search"
    ? { targetType: target.type }
    : { targetType: target.type, targetId: target.id };
}

export const AUDIT_SHOW = ["actions", "all", "views"] as const;
export type AuditShow = (typeof AUDIT_SHOW)[number];

/** The `show` in force: what a page lists when the URL names none. */
export function auditShow(search: { show?: AuditShow; requestId?: string }): AuditShow {
  return search.show ?? (search.requestId ? "all" : "actions");
}

/** The audit query's `kind` for a `show`. */
export function auditKind(show: AuditShow): "action" | "read" | undefined {
  return show === "actions" ? "action" : show === "views" ? "read" : undefined;
}
