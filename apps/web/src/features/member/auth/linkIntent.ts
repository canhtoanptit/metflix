/**
 * "Add Google to my account", carried across the steps that `link-required` sends a member
 * through (docs/BLUEPRINT-M2.md §4.1). A provider may not attach itself to an existing account,
 * so the member signs in to that account (password, or another provider), or resets its password
 * from the emailed link (another tab, perhaps another day), and is then offered the link behind
 * one confirmation on Account › Security instead of being left to find it.
 *
 * Kept in this browser's local storage (the reset link opens in a new tab) for half an hour, and
 * forgotten once offered. It is only ever an offer: linking still takes the member's click, a
 * fresh account-holder proof and their choice of account at the provider.
 */
import type { OidcProvider } from "@webflix/contracts";
import { parseProvider } from "./oidc.ts";

const KEY = "webflix:link-intent";
const LIFETIME_MS = 30 * 60_000;

export function rememberLinkIntent(provider: OidcProvider, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ provider, until: now + LIFETIME_MS }));
  } catch {
    // Without storage the member links from Account themselves, as the copy says.
  }
}

/** The provider the member wanted to add, while the wish is fresh. */
export function pendingLinkIntent(now = Date.now()): OidcProvider | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { provider?: unknown; until?: unknown };
    const provider = parseProvider(value.provider);
    if (provider && typeof value.until === "number" && value.until > now) return provider;
    localStorage.removeItem(KEY);
    return null;
  } catch {
    return null;
  }
}

export function forgetLinkIntent(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** Where the link is offered: Account › Security, with "Add Google?" ready. */
export function linkOfferPath(provider: OidcProvider): string {
  return `/account/security?link=${provider}`;
}
