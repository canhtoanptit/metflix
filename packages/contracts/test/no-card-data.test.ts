/**
 * Principle 4 of milestone 2 (docs/BLUEPRINT-M2.md §2, §5.6): card data never reaches Webflix
 * servers. No route may accept a card number, an expiry or a security code, and no response may
 * carry a card number or a security code (an expiry next to the last four digits is display
 * data the provider returns, not card data on its own).
 *
 * Milestone 1's mock sign-up, plan change and card replacement still accept a card (the web's
 * sign-up uses them until the provider's payment form replaces it), so those exact fields are
 * listed below. The billing owner empties this list together with the web checkout (§11); a
 * card field anywhere else fails the test.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { adminRoutes, defineRoute, type RouteSpec, type RouteTable, routes } from "../src/index.ts";

/** `<operationId> <location> <dot path>` of every legacy card field still accepted. */
const LEGACY_CARD_FIELDS = [
  "signup body payment.cardNumber",
  "signup body payment.expMonth",
  "signup body payment.expYear",
  "signup body payment.cvc",
  "changePlan body payment.cardNumber",
  "changePlan body payment.expMonth",
  "changePlan body payment.expYear",
  "changePlan body payment.cvc",
  "updatePaymentMethod body payment.cardNumber",
  "updatePaymentMethod body payment.expMonth",
  "updatePaymentMethod body payment.expYear",
  "updatePaymentMethod body payment.cvc",
];

type Kind = "number" | "expiry" | "code";

/** Field names (compared without case, `_` or `-`) that hold card data. */
const CARD_FIELD_NAMES: Record<string, Kind> = {
  cardnumber: "number",
  cardno: "number",
  ccnumber: "number",
  pan: "number",
  primaryaccountnumber: "number",
  accountnumber: "number",
  exp: "expiry",
  expmonth: "expiry",
  expyear: "expiry",
  expiry: "expiry",
  expirydate: "expiry",
  expiration: "expiry",
  expirationdate: "expiry",
  expirationmonth: "expiry",
  expirationyear: "expiry",
  cvc: "code",
  cvc2: "code",
  cvv: "code",
  cvv2: "code",
  csc: "code",
  cid: "code",
  securitycode: "code",
  cardsecuritycode: "code",
  cardcode: "code",
};

/** The kind of card data a property path holds, if any (`card.number` counts, `invoice.number` not). */
function cardKind(path: string): Kind | undefined {
  const segments = path.split(".").map((segment) => segment.toLowerCase().replaceAll(/[_-]/g, ""));
  const name = segments.at(-1) ?? "";
  if (name === "number" && /card|payment/.test(segments.at(-2) ?? "")) return "number";
  return CARD_FIELD_NAMES[name];
}

type Json = { [key: string]: unknown };

/** Every property path of a JSON Schema (following `$ref`s into `$defs`, cycles cut). */
function propertyPaths(schema: Json): string[] {
  const defs = (schema.$defs ?? {}) as Record<string, Json>;
  const found: string[] = [];
  const walk = (node: unknown, path: string[], seen: Set<string>) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, path, seen);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const object = node as Json;
    if (typeof object.$ref === "string") {
      const id = object.$ref.replace("#/$defs/", "");
      if (!seen.has(id) && defs[id]) walk(defs[id], path, new Set([...seen, id]));
    }
    const properties = object.properties as Record<string, unknown> | undefined;
    for (const [name, child] of Object.entries(properties ?? {})) {
      found.push([...path, name].join("."));
      walk(child, [...path, name], seen);
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf", "additionalProperties", "prefixItems"]) {
      if (key in object) walk(object[key], path, seen);
    }
  };
  walk(schema, [], new Set());
  return found;
}

function toJson(schema: z.ZodType, io: "input" | "output"): Json {
  return z.toJSONSchema(schema, { io, unrepresentable: "any", cycles: "ref" }) as Json;
}

/** Card fields a table's routes accept or return, as `<operation> <location> <path>`. */
function cardFields(table: RouteTable): string[] {
  const hits: string[] = [];
  for (const [name, route] of Object.entries(table) as [string, RouteSpec][]) {
    const requests: [string, z.ZodType | undefined][] = [
      ["params", route.params],
      ["query", route.query],
      ["body", route.body],
    ];
    for (const [location, schema] of requests) {
      if (!schema) continue;
      for (const path of propertyPaths(toJson(schema, "input"))) {
        if (cardKind(path)) hits.push(`${name} ${location} ${path}`);
      }
    }
    if (route.response) {
      for (const path of propertyPaths(toJson(route.response, "output"))) {
        const kind = cardKind(path);
        if (kind === "number" || kind === "code") hits.push(`${name} response ${path}`);
      }
    }
  }
  return hits;
}

describe("no card data in any route schema", () => {
  it("the member and staff APIs accept card data only in the listed legacy fields", () => {
    const found = [...cardFields(routes), ...cardFields(adminRoutes)];
    expect(found.filter((hit) => !LEGACY_CARD_FIELDS.includes(hit))).toEqual([]);
  });

  it("every listed legacy field still exists (the list only ever shrinks to empty)", () => {
    expect(cardFields(routes).sort()).toEqual([...LEGACY_CARD_FIELDS].sort());
  });

  it("detects card fields in requests, nested and renamed, and card numbers in responses", () => {
    const Card = z.object({
      card_number: z.string(),
      "expiry-date": z.string(),
      number: z.string(),
    });
    const table = {
      sneaky: defineRoute({
        method: "POST",
        path: "/sneaky",
        tag: "billing",
        area: "billing",
        auth: "public",
        summary: "a route that must fail the check",
        body: z.object({ wallet: z.array(z.object({ card: Card, CVV2: z.string() })) }),
        response: z.object({
          pan: z.string(),
          expMonth: z.number(),
          invoice: z.object({ number: z.string() }),
        }),
      }),
    };
    expect(cardFields(table).sort()).toEqual(
      [
        "sneaky body wallet.card.card_number",
        "sneaky body wallet.card.expiry-date",
        "sneaky body wallet.card.number",
        "sneaky body wallet.CVV2",
        "sneaky response pan",
      ].sort(),
    );
  });
});
