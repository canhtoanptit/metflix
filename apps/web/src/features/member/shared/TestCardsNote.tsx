import { MOCK_CARDS } from "@webflix/contracts";
import { ChevronDownIcon, CreditCardIcon } from "@webflix/ui";
import { formatCardNumber } from "./validation.ts";

const CARDS = [
  ["Approved", MOCK_CARDS.approved],
  ["Declined", MOCK_CARDS.declined],
  ["Insufficient funds", MOCK_CARDS.insufficientFunds],
] as const;

/**
 * Webflix bills through a simulated provider. Say so plainly next to every card form and list
 * the test cards, so nobody types a real card number into a demo.
 */
export function TestCardsNote() {
  return (
    <details className="group rounded-lg border border-line-subtle bg-surface-1 open:bg-surface-2">
      <summary className="focus-ring flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 type-label text-fg-muted marker:hidden hover:text-fg [&::-webkit-details-marker]:hidden">
        <CreditCardIcon size="sm" />
        <span className="flex-1">Demo billing: no card is ever charged</span>
        <ChevronDownIcon
          size="sm"
          className="transition-transform duration-fast group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4 type-body-sm text-fg-muted">
        <p>Use one of these test cards with any future expiry date and any 3-digit code:</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          {CARDS.map(([label, number]) => (
            <div key={label} className="contents">
              <dt>{label}</dt>
              <dd className="font-mono text-fg tabular-nums select-all">
                {formatCardNumber(number)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
