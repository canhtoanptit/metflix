import type { ImageSet } from "@webflix/contracts";
import { cx, ResponsiveImage } from "@webflix/ui";
import { useState } from "react";

export interface TitleTreatmentProps {
  name: string;
  logo: ImageSet | null;
  /** Heading element for the name (the logo is its visual form). */
  as?: "h1" | "h2" | "h3" | "p";
  /**
   * Box the logo is fitted into: a width and a max-height. Its height follows the logo's own
   * aspect ratio (so wide and tall logos both sit tight above what follows), capped by the
   * max-height. The text fallback ignores it.
   */
  logoClassName: string;
  /** Type role for the text fallback. */
  textClassName: string;
  /** `sizes` for the logo image. */
  sizes: string;
  priority?: boolean;
  className?: string;
}

/**
 * The title's logo (transparent artwork) when it has one and it loads, else its name set in the
 * display face. The name is always the accessible text. A logo that fails to load falls back to
 * the name rather than leaving an empty box.
 */
export function TitleTreatment({
  name,
  logo,
  as: Tag = "h2",
  logoClassName,
  textClassName,
  sizes,
  priority = false,
  className,
}: TitleTreatmentProps) {
  const [failed, setFailed] = useState(false);
  if (!logo || failed) {
    return <Tag className={cx(textClassName, "text-fg drop-shadow-md", className)}>{name}</Tag>;
  }
  return (
    <Tag
      className={cx("relative", logoClassName, className)}
      style={{ aspectRatio: logo.aspectRatio }}
    >
      <span className="sr-only">{name}</span>
      <LogoImage logo={logo} sizes={sizes} priority={priority} onFail={() => setFailed(true)} />
    </Tag>
  );
}

function LogoImage({
  logo,
  sizes,
  priority,
  onFail,
}: {
  logo: ImageSet;
  sizes: string;
  priority: boolean;
  onFail: () => void;
}) {
  return (
    <span
      className="absolute inset-0"
      onErrorCapture={(event) => {
        if (event.target instanceof HTMLImageElement) onFail();
      }}
    >
      <ResponsiveImage
        image={logo}
        alt=""
        fill
        fit="contain"
        position="left bottom"
        placeholder="none"
        sizes={sizes}
        priority={priority}
      />
    </span>
  );
}
