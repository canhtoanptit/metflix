import { RATING_VALUES, type RatingValue } from "@webflix/contracts";
import {
  cx,
  type IconComponent,
  ThumbsDownIcon,
  ThumbsUpDoubleIcon,
  ThumbsUpIcon,
} from "@webflix/ui";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { pop } from "../common/motion.ts";
import { RATING_LABELS, useRateTitle } from "./useRateTitle.ts";

const ICONS: Record<RatingValue, IconComponent> = {
  dislike: ThumbsDownIcon,
  like: ThumbsUpIcon,
  love: ThumbsUpDoubleIcon,
};

const SIZES = {
  sm: { box: "size-8", icon: "sm" },
  md: { box: "size-10", icon: "md" },
  lg: { box: "size-12", icon: "lg" },
} as const;

/** Pointer dwell before the choices open, and grace before they close. */
const OPEN_DELAY_MS = 180;
const CLOSE_DELAY_MS = 220;
/** Time the chosen rating stays visible (with its pop) before the choices fold away. */
const CONFIRM_MS = 420;

export interface RatingControlProps {
  title: { id: string; name: string; viewer: { rating: RatingValue | null } };
  size?: keyof typeof SIZES;
  /** Icon over a caption ("Rate"), for touch layouts. */
  labelled?: boolean;
  className?: string;
}

/**
 * Dislike / like / love. The thumb expands into the three choices on hover (pointer), on click
 * or Enter (keyboard, touch); the chosen one pops, then the control folds back showing it.
 * Choosing the current rating again clears it.
 */
export function RatingControl({
  title,
  size = "md",
  labelled = false,
  className,
}: RatingControlProps) {
  const rate = useRateTitle();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<RatingValue | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLFieldSetElement>(null);
  const hintId = useId();
  const rating = title.viewer.rating;
  const TriggerIcon = rating ? ICONS[rating] : ThumbsUpIcon;
  const dims = SIZES[size];

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const schedule = (next: boolean, delay: number) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(next);
      if (!next) setHint(null);
    }, delay);
  };

  const focusOption = (value: RatingValue) =>
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-rating="${value}"]`)?.focus();

  const openWithKeyboard = () => {
    clear();
    setOpen(true);
    requestAnimationFrame(() => focusOption(rating ?? "like"));
  };

  const choose = (value: RatingValue, viaKeyboard: boolean) => {
    const next = rating === value ? null : value;
    pop(groupRef.current?.querySelector(`[data-rating="${value}"] svg`));
    rate.mutate({ titleId: title.id, value: next, name: title.name });
    clear();
    timer.current = setTimeout(() => {
      setOpen(false);
      setHint(null);
      if (viaKeyboard) triggerRef.current?.focus();
    }, CONFIRM_MS);
  };

  // Escape while the choices are open closes them (and only them: the overlay underneath checks
  // `data-escape-local`), wherever focus is inside the control.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    setOpen(false);
    setHint(null);
    triggerRef.current?.focus();
  };

  const onGroupKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    const current = (event.target as HTMLElement).dataset.rating as RatingValue | undefined;
    const index = current ? RATING_VALUES.indexOf(current) : -1;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = RATING_VALUES[(index + delta + RATING_VALUES.length) % RATING_VALUES.length];
      if (next) focusOption(next);
    }
  };

  const triggerLabel = rating
    ? `Rated ${RATING_LABELS[rating]} — change your rating for ${title.name}`
    : `Rate ${title.name}`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer dwell is an enhancement only; keyboard and touch open the choices with the trigger button.
    <div
      className={cx("relative inline-flex", className)}
      data-escape-local={open || undefined}
      onKeyDown={onKeyDown}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") schedule(true, OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") schedule(false, CLOSE_DELAY_MS);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) schedule(false, 0);
      }}
    >
      {labelled ? (
        <button
          ref={triggerRef}
          type="button"
          aria-label={triggerLabel}
          aria-expanded={open}
          onClick={() => (open ? schedule(false, 0) : openWithKeyboard())}
          className="focus-ring flex min-w-16 flex-col items-center gap-1.5 rounded-sm px-2 py-1 text-fg"
        >
          <TriggerIcon size="lg" className={rating ? "text-accent" : undefined} />
          <span className="type-caption text-fg-muted">{rating ? "Rated" : "Rate"}</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label={triggerLabel}
          aria-expanded={open}
          onClick={() => (open ? schedule(false, 0) : openWithKeyboard())}
          className={cx(
            "focus-ring inline-grid shrink-0 place-items-center rounded-full border-2 bg-surface-2/60",
            "transition-[background-color,border-color,color] duration-fast ease-standard",
            "hover:bg-surface-3/70",
            rating ? "border-accent text-accent" : "border-line-strong text-fg hover:border-fg",
            dims.box,
          )}
        >
          <TriggerIcon size={dims.icon} />
        </button>
      )}

      {open ? (
        <fieldset
          ref={groupRef}
          aria-label={`Rate ${title.name}`}
          aria-describedby={hint ? hintId : undefined}
          onKeyDown={onGroupKeyDown}
          className={cx(
            "absolute top-1/2 left-1/2 z-(--z-raised) flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5",
            "rounded-full border border-line bg-surface-3 p-1 shadow-lg animate-scale-in",
          )}
          style={{ ["--scale-from" as string]: "0.6" }}
        >
          {hint ? (
            <span
              id={hintId}
              className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-fg px-2 py-1 type-caption font-semibold text-fg-inverse shadow-md animate-fade-in"
            >
              {RATING_LABELS[hint]}
            </span>
          ) : null}
          {RATING_VALUES.map((value) => {
            const Icon = ICONS[value];
            const selected = rating === value;
            return (
              <button
                key={value}
                type="button"
                data-rating={value}
                aria-label={RATING_LABELS[value]}
                aria-pressed={selected}
                onPointerEnter={() => setHint(value)}
                onFocus={() => setHint(value)}
                onClick={(event) => choose(value, event.detail === 0)}
                className={cx(
                  "focus-ring inline-grid place-items-center rounded-full",
                  "transition-[background-color,color,transform] duration-fast ease-standard hover:scale-110",
                  selected ? "bg-accent-subtle text-accent" : "text-fg hover:bg-surface-4",
                  dims.box,
                )}
              >
                <Icon size={dims.icon} />
              </button>
            );
          })}
        </fieldset>
      ) : null}
    </div>
  );
}
