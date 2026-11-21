import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { CloseIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { Button } from "./Button.tsx";
import { IconButton } from "./IconButton.tsx";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

const SIZES = {
  sm: "max-w-dialog-sm",
  md: "max-w-dialog-md",
  lg: "max-w-dialog-lg",
  /** The title detail modal. */
  detail: "max-w-detail",
} as const;

const OVERLAY = cx(
  "fixed inset-0 z-(--z-overlay) bg-scrim",
  "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
);

export interface DialogContentProps
  extends Omit<ComponentProps<typeof RadixDialog.Content>, "title"> {
  /** Required accessible title. Use `hideTitle` when the design shows it another way. */
  title: ReactNode;
  hideTitle?: boolean;
  description?: ReactNode;
  size?: keyof typeof SIZES;
  /**
   * `center`: vertically centred, content scrolls inside (forms, confirmations).
   * `top`: anchored near the top, the whole overlay scrolls (the long title detail modal).
   */
  placement?: "center" | "top";
  /** Close button in the corner (default true). */
  showClose?: boolean;
  /** Remove the default padding (media-led layouts such as the detail modal). */
  bleed?: boolean;
}

/**
 * Modal dialog: focus trapped and restored, Escape and backdrop close it, page scroll locked.
 * Animations come from `data-state`; override `className`/`style` for bespoke motion (the
 * detail modal growing from its card).
 */
export function DialogContent({
  title,
  hideTitle = false,
  description,
  size = "md",
  placement = "center",
  showClose = true,
  bleed = false,
  className,
  children,
  ...rest
}: DialogContentProps) {
  const panel = (
    <RadixDialog.Content
      {...(description ? {} : { "aria-describedby": undefined })}
      className={cx(
        "relative mx-auto w-full rounded-dialog bg-surface-2 text-fg shadow-xl outline-none",
        "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out",
        SIZES[size],
        placement === "center" && "max-h-[calc(100dvh-2rem)] overflow-y-auto",
        !bleed && "p-6 sm:p-8",
        className,
      )}
      {...rest}
    >
      <RadixDialog.Title className={hideTitle ? "sr-only" : "type-title-lg mb-2 pe-10"}>
        {title}
      </RadixDialog.Title>
      {description ? (
        <RadixDialog.Description className="type-body mb-6 text-fg-muted">
          {description}
        </RadixDialog.Description>
      ) : null}
      {children}
      {showClose ? (
        <RadixDialog.Close asChild>
          <IconButton
            label="Close"
            icon={CloseIcon}
            variant="glass"
            size="md"
            className="absolute end-3 top-3 z-(--z-raised)"
          />
        </RadixDialog.Close>
      ) : null}
    </RadixDialog.Content>
  );

  return (
    <RadixDialog.Portal>
      {placement === "top" ? (
        <RadixDialog.Overlay
          className={cx(OVERLAY, "grid overflow-y-auto px-2 py-6 sm:px-6 md:py-10")}
        >
          <div className="mx-auto w-full self-start justify-self-center">{panel}</div>
        </RadixDialog.Overlay>
      ) : (
        <>
          <RadixDialog.Overlay className={OVERLAY} />
          <div className="pointer-events-none fixed inset-0 z-(--z-overlay) grid place-items-center p-4">
            <div className="pointer-events-auto w-full justify-self-center [&>*]:mx-auto">
              {panel}
            </div>
          </div>
        </>
      )}
    </RadixDialog.Portal>
  );
}

/** Right-aligned action row at the bottom of a dialog (stacks on narrow screens). */
export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ConfirmDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional trigger element (otherwise control with `open`). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive actions (delete profile, cancel membership). */
  tone?: "danger" | "accent";
  loading?: boolean;
  /** Return a promise to keep the dialog open (and busy) until it settles. */
  onConfirm: () => void | Promise<void>;
}

/**
 * Confirmation for consequential actions (Radix AlertDialog: no backdrop dismissal, focus starts
 * on Cancel).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <RadixAlertDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixAlertDialog.Trigger asChild>{trigger}</RadixAlertDialog.Trigger> : null}
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={OVERLAY} />
        <div className="pointer-events-none fixed inset-0 z-(--z-overlay) grid place-items-center p-4">
          <RadixAlertDialog.Content
            className={cx(
              "pointer-events-auto w-full max-w-dialog-sm rounded-dialog bg-surface-2 p-6 text-fg shadow-xl sm:p-8",
              "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out",
            )}
          >
            <RadixAlertDialog.Title className="type-title-lg mb-2">{title}</RadixAlertDialog.Title>
            {description ? (
              <RadixAlertDialog.Description className="type-body text-fg-muted">
                {description}
              </RadixAlertDialog.Description>
            ) : null}
            <DialogFooter>
              <RadixAlertDialog.Cancel asChild>
                <Button variant="outline">{cancelLabel}</Button>
              </RadixAlertDialog.Cancel>
              <Button
                variant={tone === "danger" ? "danger" : "accent"}
                loading={loading}
                onClick={async () => {
                  await onConfirm();
                }}
              >
                {confirmLabel}
              </Button>
            </DialogFooter>
          </RadixAlertDialog.Content>
        </div>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}

const SHEET_SIDES = {
  start:
    "inset-y-0 start-0 h-full w-[min(22rem,88vw)] data-[state=open]:animate-sheet-in-start data-[state=closed]:animate-fade-out",
  end: "inset-y-0 end-0 h-full w-[min(22rem,88vw)] data-[state=open]:animate-sheet-in-end data-[state=closed]:animate-fade-out",
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-dialog data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out",
} as const;

export interface SheetContentProps
  extends Omit<ComponentProps<typeof RadixDialog.Content>, "title"> {
  title: ReactNode;
  hideTitle?: boolean;
  side?: keyof typeof SHEET_SIDES;
}

/** Edge panel (mobile navigation, filters). Use with `Dialog` / `DialogTrigger`. */
export function SheetContent({
  title,
  hideTitle = false,
  side = "end",
  className,
  children,
  ...rest
}: SheetContentProps) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={OVERLAY} />
      <RadixDialog.Content
        aria-describedby={undefined}
        className={cx(
          "fixed z-(--z-overlay) flex flex-col overflow-y-auto bg-surface-2 p-6 text-fg shadow-xl outline-none",
          SHEET_SIDES[side],
          className,
        )}
        {...rest}
      >
        <RadixDialog.Title className={hideTitle ? "sr-only" : "type-title mb-4 pe-10"}>
          {title}
        </RadixDialog.Title>
        {children}
        <RadixDialog.Close asChild>
          <IconButton
            label="Close"
            icon={CloseIcon}
            variant="ghost"
            className="absolute end-3 top-3"
          />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
