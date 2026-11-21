import {
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cx } from "../lib/cx.ts";
import { useFieldControl } from "./Field.tsx";

export interface PinInputHandle {
  focus: () => void;
  clear: () => void;
}

export interface PinInputProps {
  /** Digits entered so far ("" to "1234"). Controlled. */
  value: string;
  onChange: (value: string) => void;
  /** Called once all digits are entered. */
  onComplete?: (value: string) => void;
  length?: number;
  /** Mask digits with dots (profile PIN locks). */
  mask?: boolean;
  /** Marks every box invalid; the row shakes when it becomes true. */
  error?: boolean;
  /** Change this (e.g. an attempt counter) to replay the shake for a repeated error. */
  shakeKey?: number | string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Group label, e.g. "Enter your PIN to access this profile". */
  "aria-label"?: string;
  id?: string;
  "aria-describedby"?: string;
  className?: string;
  ref?: Ref<PinInputHandle>;
}

/**
 * Fixed-length numeric code (profile PIN). One box per digit; typing advances, Backspace goes
 * back, arrows move, pasting a code fills every box.
 */
export function PinInput({
  value,
  onChange,
  onComplete,
  length = 4,
  mask = true,
  error = false,
  shakeKey,
  autoFocus = false,
  disabled = false,
  className,
  ref,
  ...aria
}: PinInputProps) {
  const control = useFieldControl(aria);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = value.replace(/\D/g, "").slice(0, length);

  useImperativeHandle(ref, () => ({
    focus: () => inputs.current[Math.min(digits.length, length - 1)]?.focus(),
    clear: () => {
      onChange("");
      inputs.current[0]?.focus();
    },
  }));

  const [shaking, setShaking] = useState(false);

  // Cleared from outside (e.g. after a wrong PIN): start again at the first box.
  useEffect(() => {
    if (digits.length !== 0) return;
    const group = inputs.current[0]?.closest("fieldset");
    if (group?.contains(document.activeElement)) inputs.current[0]?.focus();
  }, [digits.length]);

  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (error) setShaking(true);
  }, [error, shakeKey]);

  const commit = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
    return clean;
  };

  const setDigit = (index: number, digit: string) => {
    const chars = digits.split("");
    chars[index] = digit;
    const next = commit(chars.join("").slice(0, length));
    inputs.current[Math.min(next.length, length - 1)]?.focus();
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace") {
      event.preventDefault();
      const target = digits[index] !== undefined ? index : Math.max(0, index - 1);
      commit(digits.slice(0, target));
      inputs.current[target]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      inputs.current[Math.max(0, index - 1)]?.focus();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      inputs.current[Math.min(digits.length, index + 1, length - 1)]?.focus();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const next = commit(event.clipboardData.getData("text"));
    inputs.current[Math.min(next.length, length - 1)]?.focus();
  };

  return (
    <fieldset
      aria-label={control["aria-label"]}
      aria-describedby={control["aria-describedby"]}
      id={control.id}
      className={cx("m-0 flex min-w-0 gap-3 border-0 p-0", shaking && "animate-shake", className)}
      onAnimationEnd={() => setShaking(false)}
    >
      {Array.from({ length }, (_, index) => {
        const digit = digits[index] ?? "";
        const isNext = index === Math.min(digits.length, length - 1);
        return (
          <input
            key={index}
            ref={(node) => {
              inputs.current[index] = node;
            }}
            type={mask ? "password" : "text"}
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            pattern="[0-9]*"
            maxLength={1}
            value={digit}
            disabled={disabled}
            aria-label={`Digit ${index + 1} of ${length}`}
            aria-invalid={error || undefined}
            tabIndex={isNext ? 0 : -1}
            onChange={(event) => {
              const typed = event.target.value.replace(/\D/g, "").slice(-1);
              if (typed) setDigit(Math.min(index, digits.length), typed);
            }}
            onKeyDown={(event) => onKeyDown(index, event)}
            onPaste={onPaste}
            onFocus={(event) => event.target.select()}
            className={cx(
              "focus-ring size-14 rounded-control border-2 border-line-strong bg-canvas/70 text-center",
              "font-display text-3xl font-bold text-fg caret-accent",
              "transition-[border-color,background-color] duration-fast ease-standard",
              "focus:border-fg aria-invalid:border-danger disabled:opacity-40",
              digit && "border-fg-muted",
            )}
          />
        );
      })}
    </fieldset>
  );
}
