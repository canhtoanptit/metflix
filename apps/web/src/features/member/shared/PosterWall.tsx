import { cx, ResponsiveImage } from "@webflix/ui";
import { showcaseImage, useShowcase } from "./artwork.ts";

/**
 * A tilted wall of catalog posters, used as atmosphere behind signed-out screens. Decorative
 * (the parent hides it from assistive tech); until the showcase arrives, or if it cannot, the
 * wall stays empty and the screen's scrims read as a plain backdrop.
 */
export function PosterWall({
  rows = 3,
  offset = 0,
  priority = false,
  className,
}: {
  rows?: number;
  /** Start further into the showcase list (two walls on one page should not repeat). */
  offset?: number;
  /**
   * Above the fold: the middle row(s), which the viewport centres on, load eagerly at high
   * priority (the hero's likely LCP element).
   */
  priority?: boolean;
  className?: string;
}) {
  const showcase = useShowcase();
  // Enough posters per row to cover a 2560 px-wide screen edge to edge once the wall is
  // rotated (posters cap at 13rem); rows are centred so any overflow falls equally off both
  // sides and is clipped.
  const perRow = 16;
  return (
    <div className={cx("absolute inset-0 overflow-hidden", className)}>
      {showcase.length > 0 ? (
        <div className="absolute -inset-x-1/4 -inset-y-1/3 flex -rotate-6 flex-col items-center justify-center gap-2 sm:gap-3">
          {Array.from({ length: rows }, (_, row) => (
            <div
              key={row}
              className={cx(
                "flex shrink-0 justify-center gap-2 sm:gap-3",
                row % 2 === 1 && "translate-x-[3%]",
              )}
            >
              {Array.from({ length: perRow }, (_, column) => {
                const index = offset + row * perRow + column;
                const image = showcaseImage(showcase, index, "poster");
                return image ? (
                  <ResponsiveImage
                    key={`${index}-${image.template}`}
                    image={image}
                    alt=""
                    placeholder="none"
                    priority={priority && Math.abs(row - (rows - 1) / 2) < 1}
                    sizes="(min-width: 1400px) 12vw, (min-width: 800px) 14vw, 30vw"
                    className="w-[clamp(7rem,12vw,13rem)] shrink-0 overflow-hidden rounded-md"
                  />
                ) : null;
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
