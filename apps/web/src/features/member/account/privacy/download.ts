/**
 * Saving a data export as a file. The token goes in the request's body
 * (`POST /privacy/exports/:id/download`), never in a URL (privacy review L3); the server asks for
 * a fresh "Confirm it's you" first (`reauthentication_required`), which the callers handle with
 * `useConfirmIdentity().run`.
 */
import { api } from "../../../../app/api.ts";

/** The token a request's `downloadUrl` carries (`…/exports/{id}?token={token}`). */
export function tokenOf(downloadUrl: string): string | null {
  return new URL(downloadUrl, "https://webflix.invalid").searchParams.get("token");
}

export async function saveDataExport(requestId: string, token: string): Promise<void> {
  const document = await api().fetchDataExport({ params: { id: requestId }, body: { token } });
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = Object.assign(window.document.createElement("a"), {
    href,
    download: `webflix-data-${requestId}.json`,
  });
  link.click();
  // Let the click start the download before the address is released.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
