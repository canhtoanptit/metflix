import * as z from "zod";
import { HexColor, ResourceUrl, Seconds } from "./common.ts";
import { IMAGE_FORMATS, IMAGE_TEMPLATE_FORMAT, IMAGE_TEMPLATE_WIDTH } from "./constants.ts";

export const ImageFormat = z.enum(IMAGE_FORMATS);
export type ImageFormat = z.output<typeof ImageFormat>;

const strictlyAscending = (values: readonly number[]) =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));

/**
 * A responsive image available in several widths and formats.
 *
 * The URL of one variant is `template` with `{width}` and `{format}` substituted; every
 * listed width exists in every listed format. Use `imageUrl` / `imageSrcSet` (in
 * `media-helpers.ts`) rather than substituting by hand. `aspectRatio` (width / height) lets
 * the client reserve space before load (no layout shift); `dominantColor` and `thumbhash`
 * drive the blur-up placeholder.
 */
export const ImageSet = z
  .object({
    template: ResourceUrl.refine(
      (value) => value.includes(IMAGE_TEMPLATE_WIDTH) && value.includes(IMAGE_TEMPLATE_FORMAT),
      { message: "template must contain {width} and {format}" },
    ),
    widths: z
      .array(z.number().int().positive())
      .min(1)
      .refine(strictlyAscending, { message: "widths must be strictly ascending" }),
    formats: z.array(ImageFormat).min(1),
    aspectRatio: z.number().positive().meta({ description: "width / height" }),
    dominantColor: HexColor,
    thumbhash: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .nullable()
      .meta({ description: "Base64 ThumbHash (https://evanw.github.io/thumbhash/) for blur-up." }),
  })
  .meta({ id: "ImageSet" });
export type ImageSet = z.output<typeof ImageSet>;

/** Short muted-friendly preview clip used by the billboard and hover cards. Public, cacheable. */
export const PreviewClip = z
  .object({
    url: ResourceUrl,
    durationSec: Seconds,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .meta({ id: "PreviewClip" });
export type PreviewClip = z.output<typeof PreviewClip>;
