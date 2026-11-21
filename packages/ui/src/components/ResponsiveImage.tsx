import { type ImageSet, imageSrcSet, imageUrl, pickImageWidth } from "@webflix/contracts";
import { type CSSProperties, type SyntheticEvent, useCallback, useState } from "react";
import { cx } from "../lib/cx.ts";
import { thumbhashToDataUrl } from "../lib/thumbhash.ts";

/** Formats in order of preference; the `<img>` fallback uses the last one available. */
const FORMAT_PREFERENCE = ["avif", "webp"] as const;
/** Width (CSS px) assumed for the `<img src>` fallback when `sizes` is not a plain width. */
const FALLBACK_CSS_WIDTH = 640;

export interface ResponsiveImageProps {
  image: ImageSet;
  /** Alternative text. Use "" for decorative artwork already described by nearby text. */
  alt: string;
  /** The `sizes` attribute: how wide the image renders, e.g. "(min-width: 1400px) 16vw, 46vw". */
  sizes?: string;
  /** `cover` crops to the box (default); `contain` letterboxes (logos). */
  fit?: "cover" | "contain";
  /**
   * Fill the nearest positioned ancestor instead of reserving height from the image's aspect
   * ratio. Use when the parent sets the box (billboard, fixed-ratio tiles).
   */
  fill?: boolean;
  /** Above-the-fold artwork: load eagerly with high priority (the billboard backdrop). */
  priority?: boolean;
  /** `blur` (ThumbHash over the dominant colour, default), `color` or `none`. */
  placeholder?: "blur" | "color" | "none";
  /** CSS `object-position`, e.g. "center top". */
  position?: string;
  className?: string;
  imgClassName?: string;
  style?: CSSProperties;
  onLoad?: () => void;
}

/**
 * Artwork from a contract `ImageSet`: AVIF/WebP `srcset`, blur-up from the ThumbHash and the
 * dominant colour, and zero layout shift (the box is reserved before the image arrives). Cached
 * images skip the fade so re-mounted cards (slider paging) never flash.
 */
export function ResponsiveImage({
  image,
  alt,
  sizes = "100vw",
  fit = "cover",
  fill = false,
  priority = false,
  placeholder = "blur",
  position,
  className,
  imgClassName,
  style,
  onLoad,
}: ResponsiveImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const formats = FORMAT_PREFERENCE.filter((format) => image.formats.includes(format));
  const fallbackFormat = formats[formats.length - 1] ?? image.formats[0] ?? "webp";
  const fallbackSrc = imageUrl(image, pickImageWidth(image, FALLBACK_CSS_WIDTH), fallbackFormat);
  const blurUrl = placeholder === "blur" ? thumbhashToDataUrl(image.thumbhash) : null;

  const imgRef = useCallback((node: HTMLImageElement | null) => {
    // Already decoded (browser cache): show immediately, no fade.
    if (node?.complete && node.naturalWidth > 0) setLoaded(true);
  }, []);

  const handleLoad = (_event: SyntheticEvent<HTMLImageElement>) => {
    setLoaded(true);
    onLoad?.();
  };

  return (
    <span
      className={cx("wf-image", className)}
      data-fill={fill || undefined}
      data-loaded={loaded || undefined}
      data-failed={failed || undefined}
      style={{
        aspectRatio: fill ? undefined : image.aspectRatio,
        backgroundColor: placeholder === "none" ? undefined : image.dominantColor,
        ...style,
      }}
    >
      {blurUrl ? (
        <span
          aria-hidden
          className="wf-image__placeholder absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${blurUrl})` }}
        />
      ) : null}
      <picture>
        {formats.map((format) => (
          <source
            key={format}
            type={`image/${format}`}
            srcSet={imageSrcSet(image, format)}
            sizes={sizes}
          />
        ))}
        <img
          ref={imgRef}
          src={fallbackSrc}
          alt={alt}
          sizes={sizes}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          draggable={false}
          onLoad={handleLoad}
          onError={() => setFailed(true)}
          className={cx(
            "wf-image__img absolute inset-0 size-full",
            fit === "cover" ? "object-cover" : "object-contain",
            imgClassName,
          )}
          style={position ? { objectPosition: position } : undefined}
        />
      </picture>
    </span>
  );
}
