import { Link } from "@tanstack/react-router";
import { cx, SegmentedControl, Wordmark } from "@webflix/ui";
import { useEffect, useState } from "react";
import { Browse } from "./sections/Browse.tsx";
import { Components } from "./sections/Components.tsx";
import { Foundations } from "./sections/Foundations.tsx";

const NAV: Array<[string, string]> = [
  ["brand", "Brand"],
  ["colour", "Colour"],
  ["type", "Typography"],
  ["space", "Space & elevation"],
  ["motion", "Motion"],
  ["icons", "Icons"],
  ["buttons", "Buttons"],
  ["badges", "Badges"],
  ["feedback", "Loading & toasts"],
  ["media", "Avatars & artwork"],
  ["forms", "Forms"],
  ["overlays", "Overlays"],
  ["disclosure", "Tabs & accordion"],
  ["states", "Empty & error"],
  ["browse", "Browse rows"],
];

type MotionSetting = "system" | "reduce" | "full";

function useMotionSetting(): [MotionSetting, (value: MotionSetting) => void] {
  const [value, setValue] = useState<MotionSetting>(
    () => (document.documentElement.dataset.motion as MotionSetting | undefined) ?? "system",
  );
  useEffect(() => {
    if (value === "system") delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = value;
  }, [value]);
  return [value, setValue];
}

/**
 * The living reference (development and mock builds only): every token and component in every
 * state, and the browse rows at real sizes. Run `pnpm --filter @webflix/web dev:mock` and open
 * /dev/reference.
 */
export function ReferencePage() {
  const [motion, setMotion] = useMotionSetting();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-(--z-sticky) flex h-nav items-center gap-4 border-b border-line-subtle bg-canvas/90 px-gutter backdrop-blur-md">
        <Link to="/" className="focus-ring rounded-sm" aria-label="Webflix home">
          <Wordmark className="h-5" />
        </Link>
        <span className="hidden type-label text-fg-muted sm:inline">Design reference</span>
        <SegmentedControl
          aria-label="Motion"
          value={motion}
          onValueChange={setMotion}
          options={[
            { value: "system", label: "System motion" },
            { value: "reduce", label: "Reduced" },
          ]}
          className="ms-auto"
        />
      </header>
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10 lg:ps-gutter">
        <nav aria-label="Reference sections" className="hidden lg:block">
          <ul className="sticky top-nav flex flex-col gap-0.5 py-12">
            {NAV.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className={cx(
                    "focus-ring block rounded-sm px-2 py-1.5 type-body-sm text-fg-muted hover:bg-surface-1 hover:text-fg",
                  )}
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" className="min-w-0 pb-24">
          <div className="px-gutter pt-12 pb-6 lg:ps-0">
            <h1 className="type-display-lg text-fg">Webflix design system</h1>
            <p className="mt-3 max-w-prose type-body-lg text-fg-muted">
              Tokens, components and browse primitives — every state, live. This page is the source
              of truth for how the product looks and moves; docs/DESIGN_SYSTEM.md explains the
              rules.
            </p>
          </div>
          <Foundations />
          <Components />
        </main>
      </div>
      <Browse />
    </div>
  );
}
