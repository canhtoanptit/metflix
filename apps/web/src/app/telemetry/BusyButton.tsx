/**
 * A button that is busy without being disabled (UX review 2.7): a disabled button drops the
 * keyboard focus it holds to the page, so a member pressing Enter loses their place. This one
 * keeps focus, says it is busy (`aria-busy`, a spinner, dimmed through `aria-disabled`) and ignores
 * presses until its work is done.
 */
import { Button, type ButtonProps, Spinner } from "@webflix/ui";

export function BusyButton({
  busy,
  onClick,
  children,
  ...rest
}: Omit<ButtonProps, "loading"> & {
  /** Working: focus stays, presses are ignored. (`disabled` stays for what is never available.) */
  busy: boolean;
}) {
  return (
    <Button
      {...rest}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(event) => {
        if (busy) return;
        onClick?.(event);
      }}
    >
      {busy ? <Spinner size="sm" tone="current" label={null} /> : null}
      {children}
    </Button>
  );
}

/**
 * Move focus to the page's main content (the skip link's target), for when the control that had
 * it goes away: the consent prompt once answered or put off.
 */
export function focusMainContent(): void {
  requestAnimationFrame(() => {
    const main = document.getElementById("main") ?? document.querySelector("main");
    if (!(main instanceof HTMLElement)) return;
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    main.focus({ preventScroll: true });
  });
}
