import { cx, LockIcon, TextField } from "@webflix/ui";
import {
  type ChangeEvent,
  type FocusEvent,
  type Ref,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  CARD_BRAND_LABELS,
  type CardForm,
  type CardFormErrors,
  detectCardBrand,
  digitsOnly,
  formatCardNumber,
  formatExpiryInput,
  validateCardForm,
} from "./validation.ts";

export const EMPTY_CARD: CardForm = { cardNumber: "", expiry: "", cvc: "", nameOnCard: "" };

export interface CardFieldsHandle {
  /** Validate everything, show every error, focus the first invalid field. True when valid. */
  validate(): boolean;
  focus(field: keyof CardForm): void;
}

export interface CardFieldsProps {
  value: CardForm;
  onChange: (next: CardForm) => void;
  /** Errors from the server (declined card, expired card…), shown on top of local ones. */
  serverErrors?: CardFormErrors;
  disabled?: boolean;
  ref?: Ref<CardFieldsHandle>;
}

/**
 * Card number, expiry, security code and name, built like real billing forms: numeric
 * keyboards, autofill hints (`cc-*`), live formatting that keeps the caret where the member is
 * typing, brand detection, and validation once a field has been left. Values live only in the
 * parent's component state: never in storage, the URL, logs or the query cache.
 */
export function CardFields({ value, onChange, serverErrors, disabled, ref }: CardFieldsProps) {
  const [checked, setChecked] = useState<Partial<Record<keyof CardForm, boolean>>>({});
  const refs = {
    cardNumber: useRef<HTMLInputElement>(null),
    expiry: useRef<HTMLInputElement>(null),
    cvc: useRef<HTMLInputElement>(null),
    nameOnCard: useRef<HTMLInputElement>(null),
  };
  const local = validateCardForm(value);
  const errorFor = (field: keyof CardForm) =>
    serverErrors?.[field] ?? (checked[field] ? local[field] : undefined);

  useImperativeHandle(ref, () => ({
    validate() {
      setChecked({ cardNumber: true, expiry: true, cvc: true, nameOnCard: true });
      const order: Array<keyof CardForm> = ["cardNumber", "expiry", "cvc", "nameOnCard"];
      const first = order.find((field) => validateCardForm(value)[field]);
      if (first) refs[first].current?.focus();
      return first === undefined;
    },
    focus(field) {
      refs[field].current?.focus();
    },
  }));

  const brand = detectCardBrand(digitsOnly(value.cardNumber));
  const set = (field: keyof CardForm, next: string) => onChange({ ...value, [field]: next });
  const check = (field: keyof CardForm) => (event: FocusEvent<HTMLInputElement>) => {
    if (event.target.value.trim()) setChecked((current) => ({ ...current, [field]: true }));
  };

  const onCardNumber = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = digitsOnly(input.value.slice(0, caret)).length;
    const formatted = formatCardNumber(input.value);
    set("cardNumber", formatted);
    // Reformatting replaces the value; put the caret back after the same digit.
    requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      let position = 0;
      let seen = 0;
      while (position < formatted.length && seen < digitsBeforeCaret) {
        if (/\d/.test(formatted.charAt(position))) seen += 1;
        position += 1;
      }
      input.setSelectionRange(position, position);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <TextField
        ref={refs.cardNumber}
        label="Card number"
        name="cc-number"
        autoComplete="cc-number"
        inputMode="numeric"
        autoCorrect="off"
        spellCheck={false}
        maxLength={23}
        required
        disabled={disabled}
        value={value.cardNumber}
        onChange={onCardNumber}
        onBlur={check("cardNumber")}
        error={errorFor("cardNumber")}
        endAdornment={
          <span
            className={cx(
              "pe-2.5 type-caption whitespace-nowrap transition-colors duration-fast",
              brand === "other" ? "text-fg-subtle" : "text-fg",
            )}
          >
            {brand === "other" ? (
              <LockIcon size="sm" label="Secure field" />
            ) : (
              CARD_BRAND_LABELS[brand]
            )}
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <TextField
          ref={refs.expiry}
          label="Expiry (MM / YY)"
          name="cc-exp"
          autoComplete="cc-exp"
          inputMode="numeric"
          maxLength={7}
          required
          disabled={disabled}
          value={value.expiry}
          onChange={(event) => set("expiry", formatExpiryInput(event.target.value, value.expiry))}
          onBlur={check("expiry")}
          error={errorFor("expiry")}
        />
        <TextField
          ref={refs.cvc}
          label="Security code"
          name="cc-csc"
          autoComplete="cc-csc"
          inputMode="numeric"
          maxLength={brand === "amex" ? 4 : 3}
          required
          disabled={disabled}
          value={value.cvc}
          onChange={(event) => set("cvc", digitsOnly(event.target.value).slice(0, 4))}
          onBlur={check("cvc")}
          error={errorFor("cvc")}
        />
      </div>
      <TextField
        ref={refs.nameOnCard}
        label="Name on card"
        name="cc-name"
        autoComplete="cc-name"
        autoCapitalize="words"
        spellCheck={false}
        maxLength={100}
        required
        disabled={disabled}
        value={value.nameOnCard}
        onChange={(event) => set("nameOnCard", event.target.value)}
        onBlur={check("nameOnCard")}
        error={errorFor("nameOnCard")}
      />
    </div>
  );
}
