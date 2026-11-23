import { Toast as RadixToast } from "radix-ui";
import { useSyncExternalStore } from "react";
import type { IconComponent } from "../icons/createIcon.tsx";
import { AlertCircleIcon, CheckCircleIcon, CloseIcon, InfoIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { getToasts, subscribeToasts, type ToastTone, toast, updateToasts } from "./toast-store.ts";

const TONE_ICON: Record<ToastTone, IconComponent> = {
  neutral: InfoIcon,
  success: CheckCircleIcon,
  error: AlertCircleIcon,
};
const TONE_CLASS: Record<ToastTone, string> = {
  neutral: "text-info",
  success: "text-positive",
  error: "text-danger",
};

/** Radix toast region: announced politely (errors assertively), swipe to dismiss on touch. */
export function ToastViewport() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <RadixToast.Provider swipeDirection="down" label="Notifications">
      {items.map((item) => {
        const tone = item.tone ?? "neutral";
        const Icon = TONE_ICON[tone];
        return (
          <RadixToast.Root
            key={`${item.id}:${item.serial}`}
            open={item.open}
            type={tone === "error" ? "foreground" : "background"}
            duration={item.duration ?? (tone === "error" ? 8000 : 5000)}
            onOpenChange={(open) => {
              if (!open && getToasts().some((record) => record.serial === item.serial))
                toast.dismiss(item.id);
            }}
            onAnimationEnd={() => {
              if (!item.open)
                updateToasts(getToasts().filter((record) => record.serial !== item.serial));
            }}
            className={cx(
              "pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line bg-surface-3 p-4 text-fg shadow-lg",
              "data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-out",
              "data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=cancel]:translate-y-0",
              "data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-fade-out",
            )}
          >
            <Icon size="md" className={cx("mt-0.5", TONE_CLASS[tone])} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <RadixToast.Title className="type-label text-fg">{item.title}</RadixToast.Title>
              {item.description ? (
                <RadixToast.Description className="type-body-sm text-fg-muted">
                  {item.description}
                </RadixToast.Description>
              ) : null}
            </div>
            {item.action ? (
              <RadixToast.Action
                altText={item.action.altText ?? item.action.label}
                onClick={item.action.onClick}
                className="focus-ring shrink-0 rounded-sm px-2 py-1 type-label text-accent hover:underline"
              >
                {item.action.label}
              </RadixToast.Action>
            ) : null}
            <RadixToast.Close
              aria-label="Dismiss"
              className="focus-ring -me-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-sm text-fg-muted hover:text-fg"
            >
              <CloseIcon size="sm" />
            </RadixToast.Close>
          </RadixToast.Root>
        );
      })}
      <RadixToast.Viewport
        className={cx(
          // Phones: across the bottom. Wider: the bottom corner at the end of the line, beside
          // the content column rather than on top of it.
          "fixed inset-x-0 bottom-0 z-(--z-toast) mx-auto flex w-full max-w-dialog-sm flex-col gap-2 p-4 outline-none",
          "sm:inset-x-auto sm:end-0 sm:mx-0 sm:p-6",
          // A screen with a bar fixed to the bottom sets --wf-toast-offset to its height.
          "mb-(--wf-toast-offset)",
        )}
      />
    </RadixToast.Provider>
  );
}
