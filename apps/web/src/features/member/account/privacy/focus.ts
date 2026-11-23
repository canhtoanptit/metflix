/**
 * Focus after an action on the privacy page (UX review 2.7): onto what happened (the scheduled
 * notice, the export being prepared, the resume notice) or the section's heading, never left on
 * the page's body. Found by id when it is time to focus, since the page may rebuild the section
 * meanwhile (it moves to the top while a deletion is scheduled). A dialog that was open for the
 * action ("Delete your account?", "Confirm it's you") puts focus back where it was when it
 * finishes closing, so this waits for every dialog to be gone, and puts focus back once more if
 * the closing dialog dropped it on the body.
 */
export function focusAfterDialogs(find: () => HTMLElement | null, attempts = 40): void {
  const dialogOpen = document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
  const element = dialogOpen ? null : find();
  if (element) {
    focusOn(element);
    window.setTimeout(() => {
      const again = find();
      if (again && document.activeElement === document.body) focusOn(again);
    }, 250);
    return;
  }
  if (attempts > 0) window.setTimeout(() => focusAfterDialogs(find, attempts - 1), 50);
}

function focusOn(element: HTMLElement): void {
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus();
}

export const byId = (id: string) => () => document.getElementById(id);
