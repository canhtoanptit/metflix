/**
 * Focus after an action that changes or leaves the page (UX review 2.7): plan change, cancel,
 * keep and restart land on the destination's heading (or the outcome), never on <body>, so a
 * screen reader announces where the member is and the keyboard starts from there.
 */

/** Focus `target` (made programmatically focusable) once it is in the page, for up to ~1.5 s. */
export function focusWhenReady(find: () => HTMLElement | null, attempts = 30): void {
  const element = find();
  if (element) {
    if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
    element.focus({ preventScroll: false });
    return;
  }
  if (attempts > 0) window.setTimeout(() => focusWhenReady(find, attempts - 1), 50);
}

/**
 * The page's own heading (`main h1`), once the destination has rendered it: `title` names the
 * destination's heading, so the page being left (still mounted for a moment) is never focused.
 */
export function focusPageHeading(title?: string): void {
  focusWhenReady(() => {
    const heading = document.querySelector<HTMLElement>("main h1");
    return heading && (title === undefined || heading.textContent?.trim() === title)
      ? heading
      : null;
  });
}
