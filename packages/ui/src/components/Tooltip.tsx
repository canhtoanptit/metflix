import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/cx.ts";

/**
 * Optional: wrap a group of tooltips (a toolbar, a preview's action row) so moving between them
 * skips the delay. Each `Tooltip` provides its own context otherwise, so nothing needs to be
 * mounted at the app root and tooltip code loads only with screens that use it.
 */
export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  /** The trigger: a single focusable element (button, link). */
  children: ReactElement;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Delay before showing, in ms (defaults to the provider's). */
  delayDuration?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Short label on hover and keyboard focus. Supplementary only: never put information in a
 * tooltip that is not also available another way (touch devices never see it).
 */
export function Tooltip({
  children,
  content,
  side = "top",
  align = "center",
  delayDuration,
  open,
  onOpenChange,
  className,
}: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <RadixTooltip.Root delayDuration={delayDuration} open={open} onOpenChange={onOpenChange}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            align={align}
            sideOffset={8}
            collisionPadding={12}
            className={cx(
              "z-(--z-tooltip) max-w-64 rounded-sm bg-fg px-2.5 py-1.5 text-fg-inverse shadow-md",
              "text-xs font-semibold leading-snug",
              "data-[state=delayed-open]:animate-fade-in data-[state=instant-open]:animate-fade-in",
              // No exit animation: a closing tooltip stays mounted as the top dismissable layer
              // for as long as it fades, and takes the Escape meant for the dialog under it
              // (Tab past a control, press Escape at once: the detail overlay stayed open).
              className,
            )}
          >
            {content}
            <RadixTooltip.Arrow className="fill-fg" width={10} height={5} />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
