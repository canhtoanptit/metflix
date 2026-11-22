/**
 * Saving a data export as a file from what the API answers (`GET /privacy/exports/:id?token=`):
 * the export link landing (the email's link) and mock mode use it. The signed-in privacy page
 * links straight to the export instead, which lets the browser stream it.
 */
import { api } from "../../../../app/api.ts";

export async function saveDataExport(requestId: string, token: string): Promise<void> {
  const document = await api().downloadDataExport({ params: { id: requestId }, query: { token } });
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
