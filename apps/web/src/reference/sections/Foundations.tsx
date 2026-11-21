import { AppIcon, BrandMark, Button, cx, OriginalLabel, Wordmark } from "@webflix/ui";
import { useEffect, useState } from "react";
import { Caption, Demo, Labeled, Section } from "../Specimen.tsx";

// --- Colour maths (live from the CSS tokens, so the page can never disagree with the CSS) ------

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/.exec(
    v,
  );
  if (rgb) {
    const alphaRaw = rgb[4];
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith("%")
          ? Number.parseFloat(alphaRaw) / 100
          : Number(alphaRaw);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), alpha];
  }
  return null;
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function useToken(name: string): string {
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  }, [name]);
  return value;
}

/** [token, use, measured against: another colour token, "white", or null for no ratio] */
type SwatchSpec = [string, string, string | null];

const COLOR_GROUPS: Array<{ title: string; note: string; tokens: SwatchSpec[] }> = [
  {
    title: "Surfaces",
    note: "Cool near-black: content (artwork) carries the colour, chrome stays quiet.",
    tokens: [
      ["canvas", "Page background", null],
      ["surface-1", "Cards, placeholders, panels", null],
      ["surface-2", "Menus, dialogs", null],
      ["surface-3", "Hover, inputs on surfaces, FAQ bars", null],
      ["surface-4", "Pressed, tracks", null],
      ["glass", "Frosted controls over artwork (white text ≥ 4.5:1 even over white art)", null],
      ["scrim", "Modal backdrop", null],
    ],
  },
  {
    title: "Content",
    note: "Every text token passes AA on canvas and surfaces 1–3.",
    tokens: [
      ["fg", "Primary text, primary button", "canvas"],
      ["fg-muted", "Secondary text", "canvas"],
      ["fg-subtle", "Tertiary text, placeholders", "canvas"],
      ["fg-disabled", "Disabled (exempt from contrast)", null],
      ["fg-on-accent", "Text on amber", "accent"],
    ],
  },
  {
    title: "Accent and status",
    note: "One accent — marquee amber — for brand moments, primary calls to action, progress and selection.",
    tokens: [
      ["accent", "Brand CTA, progress, selection", "canvas"],
      ["accent-hover", "Hover", "canvas"],
      ["accent-active", "Pressed", "canvas"],
      ["accent-subtle", "Tinted backgrounds", null],
      ["positive", "Match score, success", "canvas"],
      ["danger", "Errors (text)", "canvas"],
      ["danger-solid", "Destructive buttons (white text)", "white"],
      ["warning", "Warnings", "canvas"],
      ["info", "Information", "canvas"],
    ],
  },
  {
    title: "Lines",
    note: "line-strong passes 3:1 for control boundaries.",
    tokens: [
      ["line-subtle", "Dividers", null],
      ["line", "Borders of menus, cards", null],
      ["line-strong", "Input and outline-button borders (3:1)", "canvas"],
      ["track", "Progress track over artwork", null],
      ["focus", "Focus ring", "canvas"],
    ],
  },
];

function Swatch({ token, use, against }: { token: string; use: string; against: string | null }) {
  const value = useToken(`--color-${token}`);
  const canvas = parseColor(useToken("--color-canvas") || "#0b0c0f");
  const againstValue = useToken(
    against && against !== "white" ? `--color-${against}` : "--color-white",
  );
  const color = parseColor(value);
  const base = against === "white" ? parseColor("#ffffff") : parseColor(againstValue);
  const ratio =
    against && color && base && canvas ? contrast(over(color, canvas), over(base, canvas)) : null;
  return (
    <div className="flex w-44 flex-col gap-2">
      <div
        className="h-16 rounded-md border border-line-subtle"
        style={{ backgroundColor: `var(--color-${token})` }}
      />
      <div className="flex flex-col gap-0.5">
        <span className="type-label text-fg">{token}</span>
        <span className="type-caption text-fg-subtle">{use}</span>
        <Caption>
          {value || "…"}
          {ratio !== null ? ` · ${ratio.toFixed(2)}:1 vs ${against}` : ""}
        </Caption>
      </div>
    </div>
  );
}

const TYPE_ROLES: Array<[string, string, string]> = [
  ["type-display-xl", "Display XL", "Mona Sans 900, 112% width · hero headlines"],
  ["type-display-lg", "Display L", "Mona Sans 850, 110% · landing hero"],
  ["type-display-md", "Display M", "Mona Sans 800, 106% · page titles"],
  ["type-headline", "Headline", "Mona Sans 750 · section titles"],
  ["type-title-lg", "Title L", "Mona Sans 700 · dialog and card titles"],
  ["type-row-title", "Row title", "Mona Sans 700, fluid with the rows"],
  ["type-title", "Title", "Inter 700 · compact titles"],
  ["type-body-lg", "Body L", "Inter 400 · synopsis"],
  ["type-body", "Body", "Inter 400 · default text"],
  ["type-body-sm", "Body S", "Inter 400 · metadata"],
  ["type-label", "Label", "Inter 600 · controls, form labels"],
  ["type-caption", "Caption", "Inter 500 · fine print"],
  ["type-overline", "Overline", "Inter 700 caps · eyebrows, badges"],
];

const SPACING = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
const RADII: Array<[string, string]> = [
  ["rounded-xs", "xs 2"],
  ["rounded-sm", "sm 4"],
  ["rounded-card", "card 6"],
  ["rounded-menu", "menu 8"],
  ["rounded-dialog", "dialog 12"],
  ["rounded-2xl", "2xl 16"],
  ["rounded-full", "full"],
];
const SHADOWS = ["shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-glow"];
const DURATIONS = ["instant", "fast", "base", "slow", "slower", "cinematic"] as const;
const EASINGS = ["standard", "enter", "exit", "glide", "momentum", "spring"] as const;

function MotionDemo() {
  const [on, setOn] = useState(false);
  return (
    <div className="flex w-full flex-col gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOn((value) => !value)}
        className="self-start"
      >
        Play motion
      </Button>
      {EASINGS.map((ease) => (
        <div key={ease} className="flex items-center gap-4">
          <span className="w-24 type-caption text-fg-muted">ease-{ease}</span>
          <div className="relative h-6 flex-1 rounded-full bg-surface-1">
            <span
              className="absolute top-0 left-0 size-6 rounded-full bg-accent transition-transform"
              style={{
                transform: on ? "translateX(calc(min(60vw, 40rem) - 1.5rem))" : "translateX(0)",
                transitionDuration: "var(--duration-slower)",
                transitionTimingFunction: `var(--ease-${ease})`,
              }}
            />
          </div>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-4">
        {DURATIONS.map((name) => (
          <DurationToken key={name} name={name} />
        ))}
      </div>
    </div>
  );
}

function DurationToken({ name }: { name: string }) {
  const value = useToken(`--duration-${name}`);
  return <Caption>{`--duration-${name}: ${value}`}</Caption>;
}

export function Foundations() {
  return (
    <>
      <Section
        id="brand"
        title="Brand"
        description="WEBFLIX set in Mona Sans Black at 125% width, lit with a warm amber gradient (projector light on a dark auditorium). The W mark carries the brand where the wordmark cannot fit."
      >
        <Demo
          title="Wordmark"
          note="Height sets size; keep half the cap height clear on every side."
        >
          <div className="rounded-lg bg-canvas p-8 ring-1 ring-line-subtle">
            <Wordmark className="h-10" />
          </div>
          <div className="rounded-lg bg-surface-2 p-8">
            <Wordmark tone="light" className="h-10" />
          </div>
          <div className="rounded-lg bg-accent p-8">
            <Wordmark tone="dark" className="h-10" />
          </div>
        </Demo>
        <Demo title="Mark and app icon">
          {[16, 24, 32, 48, 64].map((size) => (
            <Labeled key={size} label={`${size}px`}>
              <BrandMark style={{ width: size, height: size }} title="Webflix" />
            </Labeled>
          ))}
          {[16, 32, 64, 128].map((size) => (
            <Labeled key={`icon-${size}`} label={`app ${size}`}>
              <AppIcon style={{ width: size, height: size }} title="Webflix" />
            </Labeled>
          ))}
        </Demo>
        <Demo title="Originals eyebrow">
          <OriginalLabel kind="series" />
          <OriginalLabel kind="film" className="text-xl" />
        </Demo>
      </Section>

      <Section
        id="colour"
        title="Colour"
        description="Dark, cinematic, content-first. Values and contrast ratios below are read live from the tokens."
      >
        {COLOR_GROUPS.map((group) => (
          <Demo
            key={group.title}
            title={group.title}
            note={group.note}
            className="items-start gap-6"
          >
            {group.tokens.map(([token, use, against]) => (
              <Swatch key={token} token={token} use={use} against={against} />
            ))}
          </Demo>
        ))}
      </Section>

      <Section
        id="type"
        title="Typography"
        description="Inter for interface text (legible at small sizes, tabular figures). Mona Sans for display: one variable family in three postures — expanded for brand and heroes, normal for headings, condensed for Top 10 numerals. Both self-hosted, SIL OFL."
      >
        <div className="flex flex-col gap-6">
          {TYPE_ROLES.map(([className, name, spec]) => (
            <div
              key={className}
              className="grid gap-2 border-b border-line-subtle pb-6 md:grid-cols-[12rem_1fr] md:gap-8"
            >
              <div className="flex flex-col gap-0.5">
                <span className="type-label text-fg">{name}</span>
                <Caption>{className}</Caption>
                <span className="type-caption text-fg-subtle">{spec}</span>
              </div>
              <p className={cx(className, "text-fg")}>Stories that stay with you</p>
            </div>
          ))}
          <Demo title="Numerals" note="Mona Sans condensed, outlined (Top 10 rows)">
            <span className="wf-tile-numeral type-numeral text-[8rem]">1</span>
            <span className="wf-tile-numeral type-numeral text-[8rem]">7</span>
            <span className="wf-tile-numeral type-numeral text-[8rem]">10</span>
            <span className="type-body tabular-nums text-fg-muted">1:52:07 · 2024 · 98% match</span>
          </Demo>
        </div>
      </Section>

      <Section
        id="space"
        title="Space, radii, elevation"
        description="A 4px grid. The page gutter (4% of width) aligns the navigation, billboard copy, row titles and the slider peeks."
      >
        <Demo title="Spacing scale" className="items-end">
          {SPACING.map((step) => (
            <Labeled key={step} label={`${step} · ${step * 4}px`}>
              <span
                className="block w-6 rounded-xs bg-accent"
                style={{ height: `calc(var(--spacing) * ${step})` }}
              />
            </Labeled>
          ))}
        </Demo>
        <Demo title="Layout tokens">
          <Labeled label="--spacing-gutter: max(1rem, 4vw)">
            <span className="block h-4 w-gutter rounded-xs bg-info" />
          </Labeled>
          <Labeled label="--spacing-nav">
            <span className="block h-nav w-4 rounded-xs bg-info" />
          </Labeled>
          <Labeled label="--spacing-row-gap (fluid)">
            <span className="block h-row-gap w-4 rounded-xs bg-info" />
          </Labeled>
        </Demo>
        <Demo title="Radii">
          {RADII.map(([className, label]) => (
            <Labeled key={className} label={label}>
              <span
                className={cx("block size-16 border border-line-strong bg-surface-2", className)}
              />
            </Labeled>
          ))}
        </Demo>
        <Demo
          title="Elevation"
          note="Shadows deepen with height; raised layers also step up a surface."
        >
          {SHADOWS.map((shadow, index) => (
            <Labeled key={shadow} label={shadow}>
              <span
                className={cx(
                  "block size-24 rounded-lg",
                  shadow,
                  index > 2 ? "bg-surface-2" : "bg-surface-1",
                )}
              />
            </Labeled>
          ))}
        </Demo>
      </Section>

      <Section
        id="motion"
        title="Motion"
        description="Animate transform and opacity only. Durations are tokens; under reduced motion (or the toggle in the header) movement durations become 0 and state changes dissolve instead."
      >
        <MotionDemo />
      </Section>
    </>
  );
}
