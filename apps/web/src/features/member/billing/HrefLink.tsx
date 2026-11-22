import { useNavigate } from "@tanstack/react-router";
import type { AnchorHTMLAttributes, Ref } from "react";

/**
 * A same-origin link to a path built at run time (`/signup/payment?plan=basic`), navigated by the
 * router: a real anchor for the keyboard, screen readers, new tabs and the status bar, without
 * reloading the app. Use the router's `Link` wherever the destination is a static route.
 */
export function HrefLink({
  href,
  onClick,
  ref,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement> }) {
  const navigate = useNavigate();
  return (
    <a
      ref={ref}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void navigate({ href });
      }}
      {...rest}
    />
  );
}
