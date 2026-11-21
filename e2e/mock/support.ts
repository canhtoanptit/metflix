import type { Page } from "@playwright/test";

export type MockSession = "anonymous" | "account" | "profile";

/** Open a path with the mock backend reset to a session state. */
export async function gotoAs(page: Page, path: string, session: MockSession): Promise<void> {
  const url = new URL(path, "http://placeholder");
  url.searchParams.set("mock-session", session);
  await page.goto(`${url.pathname}${url.search}`);
}

/** Pathname plus search without the mock-only parameter. */
export function cleanLocation(page: Page): string {
  const url = new URL(page.url());
  url.searchParams.delete("mock-session");
  return `${url.pathname}${url.search}`;
}
