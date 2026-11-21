import { type InputHTMLAttributes, type Ref, useRef } from "react";
import { CloseIcon, SearchIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { mergeRefs } from "../lib/hooks.ts";

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "type"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Called after the clear button empties the field (focus stays in the field). */
  onClear?: () => void;
  /** Accessible name, e.g. "Search titles, people, genres". */
  label: string;
  size?: "md" | "lg";
  ref?: Ref<HTMLInputElement>;
}

/**
 * Search field with a leading icon and a clear button. The expanding behaviour of the navigation
 * search belongs to the navigation; this is the field inside it.
 */
export function SearchInput({
  value,
  onValueChange,
  onClear,
  label,
  size = "md",
  className,
  ref,
  ...rest
}: SearchInputProps) {
  const inner = useRef<HTMLInputElement>(null);
  return (
    <div className={cx("relative flex items-center", className)}>
      <SearchIcon
        size={size === "lg" ? "lg" : "md"}
        className="pointer-events-none absolute start-3 text-fg-muted"
      />
      <input
        ref={mergeRefs(ref, inner)}
        type="search"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        className={cx(
          "focus-ring w-full rounded-control border border-line-strong bg-canvas/80 text-fg placeholder:text-fg-subtle",
          "transition-[border-color] duration-fast ease-standard hover:border-fg-subtle focus:border-fg",
          "[&::-webkit-search-cancel-button]:appearance-none",
          size === "lg" ? "h-14 ps-12 pe-12 text-lg" : "h-10 ps-10 pe-10 text-md",
        )}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange("");
            onClear?.();
            inner.current?.focus();
          }}
          className="focus-ring-inset absolute end-1.5 grid size-8 place-items-center rounded-sm text-fg-muted hover:text-fg"
        >
          <CloseIcon size="sm" />
        </button>
      ) : null}
    </div>
  );
}
