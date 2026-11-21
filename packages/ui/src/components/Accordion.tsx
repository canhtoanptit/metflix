import { Accordion as RadixAccordion } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { PlusIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

export type AccordionProps = ComponentProps<typeof RadixAccordion.Root> & {
  /** `faq`: large solid bars (landing page FAQ). `plain`: divided rows (settings, help). */
  variant?: "faq" | "plain";
};

export function Accordion({ variant = "faq", className, ...rest }: AccordionProps) {
  return (
    <RadixAccordion.Root
      data-variant={variant}
      className={cx("group/accordion flex flex-col", variant === "faq" ? "gap-2" : "", className)}
      {...rest}
    />
  );
}

export interface AccordionItemProps {
  value: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

/** One question/answer. The heading level is h3; the plus rotates into a close mark. */
export function AccordionItem({ value, title, children, className }: AccordionItemProps) {
  return (
    <RadixAccordion.Item
      value={value}
      className={cx(
        "group-data-[variant=plain]/accordion:border-b group-data-[variant=plain]/accordion:border-line",
        className,
      )}
    >
      <RadixAccordion.Header asChild>
        <h3>
          <RadixAccordion.Trigger
            className={cx(
              "group/trigger focus-ring flex w-full items-center justify-between gap-6 text-start text-fg",
              "transition-colors duration-fast ease-standard",
              "group-data-[variant=faq]/accordion:min-h-16 group-data-[variant=faq]/accordion:bg-surface-3",
              "group-data-[variant=faq]/accordion:px-6 group-data-[variant=faq]/accordion:py-5",
              "group-data-[variant=faq]/accordion:text-[clamp(1.0625rem,0.95rem+0.45vw,1.5rem)]",
              "group-data-[variant=faq]/accordion:hover:bg-surface-4",
              "group-data-[variant=plain]/accordion:py-4 group-data-[variant=plain]/accordion:type-label",
            )}
          >
            <span>{title}</span>
            <PlusIcon
              size="lg"
              className="shrink-0 transition-transform duration-base ease-standard group-data-[state=open]/trigger:rotate-45"
            />
          </RadixAccordion.Trigger>
        </h3>
      </RadixAccordion.Header>
      <RadixAccordion.Content
        className={cx(
          "overflow-hidden data-[state=open]:animate-fade-in",
          "group-data-[variant=faq]/accordion:mt-px group-data-[variant=faq]/accordion:bg-surface-3",
        )}
      >
        <div
          className={cx(
            "text-fg-muted",
            "group-data-[variant=faq]/accordion:px-6 group-data-[variant=faq]/accordion:py-6",
            "group-data-[variant=faq]/accordion:text-[clamp(1rem,0.92rem+0.35vw,1.375rem)]",
            "group-data-[variant=plain]/accordion:pb-4 group-data-[variant=plain]/accordion:type-body",
          )}
        >
          {children}
        </div>
      </RadixAccordion.Content>
    </RadixAccordion.Item>
  );
}
