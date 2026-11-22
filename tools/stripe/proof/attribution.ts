/**
 * Which scenario a webhook event belongs to. `stripe listen` forwards every event of the account,
 * and scenarios run concurrently, so each event is assigned by the ids its object refers to.
 * Only "anchor" references count (the object itself, its customer, clock, subscription,
 * invoice, payment, product, coupon…), never line-item prices: every subscription refers to
 * the shared catalogue, and the catalogue must not claim them. Ownership spreads: once an
 * event is assigned, its object's id joins the owner's set (an invoice owned through its
 * customer then owns its payment's events), so assignment repeats until nothing changes.
 */

const ANCHOR_PATHS: readonly (readonly string[])[] = [
  ["id"],
  ["customer"],
  ["test_clock"],
  ["subscription"],
  ["invoice"],
  ["charge"],
  ["payment_intent"],
  ["setup_intent"],
  ["payment_method"],
  ["product"],
  ["coupon"],
  ["promotion_code"],
  ["parent", "subscription_details", "subscription"],
  ["parent", "invoice_item_details", "invoice"],
  ["promotion", "coupon"],
  ["source", "coupon"],
  ["payment", "payment_intent"],
];

function at(object: unknown, path: readonly string[]): unknown {
  let current: unknown = object;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Ids an event's object refers to through its anchor fields (expanded objects included). */
export function anchorIds(object: unknown): string[] {
  const ids: string[] = [];
  for (const path of ANCHOR_PATHS) {
    const value = at(object, path);
    if (typeof value === "string") ids.push(value);
    else if (
      value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string"
    ) {
      ids.push((value as { id: string }).id);
    }
  }
  return ids;
}

export interface Attributable {
  seq: number;
  object: unknown;
}

export interface Owner {
  name: string;
  owned: Set<string>;
  /** Deliveries before this sequence number cannot belong to the owner. */
  firstSeq: number;
}

export interface Attribution {
  byOwner: Map<string, number[]>;
  unattributed: number[];
  /** Deliveries whose anchors matched more than one owner (assigned to the first). */
  ambiguous: number[];
}

export function attribute(items: readonly Attributable[], owners: readonly Owner[]): Attribution {
  const byOwner = new Map<string, number[]>(owners.map((o) => [o.name, []]));
  const assigned = new Map<number, string>();
  const ambiguous = new Set<number>();
  const owned = new Map(owners.map((o) => [o.name, new Set(o.owned)]));

  for (let changed = true; changed; ) {
    changed = false;
    for (const item of items) {
      if (assigned.has(item.seq)) continue;
      const anchors = anchorIds(item.object);
      const matches = owners.filter(
        (o) => item.seq >= o.firstSeq && anchors.some((id) => owned.get(o.name)?.has(id)),
      );
      const first = matches[0];
      if (!first) continue;
      if (matches.length > 1) ambiguous.add(item.seq);
      assigned.set(item.seq, first.name);
      const selfId = anchors[0];
      const set = owned.get(first.name);
      if (selfId && set && typeof (item.object as { id?: unknown })?.id === "string")
        set.add(selfId);
      changed = true;
    }
  }

  for (const item of items) {
    const owner = assigned.get(item.seq);
    if (owner) byOwner.get(owner)?.push(item.seq);
  }
  for (const list of byOwner.values()) list.sort((a, b) => a - b);
  const unattributed = items.filter((i) => !assigned.has(i.seq)).map((i) => i.seq);
  return { byOwner, unattributed, ambiguous: [...ambiguous].sort((a, b) => a - b) };
}

/**
 * Pairs delivered in the opposite order to their creation (`created`, whole seconds, so events
 * created in the same second never count). Stripe documents that it does not guarantee order;
 * this measures how often it happened in practice.
 */
export function inversions(
  events: ReadonlyArray<{ seq: number; created: number; id: string; type: string }>,
): Array<{
  earlier: { id: string; type: string; created: number };
  later: { id: string; type: string; created: number };
}> {
  const out: Array<{
    earlier: { id: string; type: string; created: number };
    later: { id: string; type: string; created: number };
  }> = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const first = sorted[i];
      const second = sorted[j];
      if (first && second && first.created > second.created && first.id !== second.id) {
        out.push({
          earlier: { id: second.id, type: second.type, created: second.created },
          later: { id: first.id, type: first.type, created: first.created },
        });
      }
    }
  }
  return out;
}
