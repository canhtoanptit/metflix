/**
 * Where focus goes when the detail overlay closes. Radix restores focus to whatever was focused
 * when the dialog opened; that is wrong when the opener disappears with it (a hover preview's
 * "More info" button). Openers that vanish register the stable element to return to instead:
 * the card the preview grew from.
 */
let target: HTMLElement | null = null;

export function setOverlayReturnFocus(element: HTMLElement | null): void {
  target = element;
}

/** Take (and forget) the registered element, if it is still in the document. */
export function takeOverlayReturnFocus(): HTMLElement | null {
  const element = target;
  target = null;
  return element?.isConnected ? element : null;
}
