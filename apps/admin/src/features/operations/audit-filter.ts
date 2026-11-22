/** An audit-log filter for a target, never carrying a member search's query (personal data). */
export function auditFilterFor(target: { type: string; id: string }): {
  targetType: string;
  targetId?: string;
} {
  return target.type === "member_search"
    ? { targetType: target.type }
    : { targetType: target.type, targetId: target.id };
}
