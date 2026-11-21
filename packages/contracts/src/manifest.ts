/**
 * The manifest `tools/media` emits after packaging (`.cache/media/<profile>/manifest.json`,
 * uploaded next to the blobs). The API seeder joins it with the catalog seed: an asset in the
 * manifest is `packaged`; an asset only in the seed with `externalHlsUrl` is `external`.
 * All blob keys follow the layout in `media.ts` (`blobKeys`).
 */
import * as z from "zod";
import { HexColor, Id, IsoDateTime, LanguageTag, Seconds } from "./common.ts";
import {
  IMAGE_TEMPLATE_FORMAT,
  IMAGE_TEMPLATE_WIDTH,
  MEDIA_MANIFEST_VERSION,
  MEDIA_PROFILES,
} from "./constants.ts";
import { ImageFormat, type ImageSet } from "./media.ts";
import { cdnUrlForBlobKey } from "./media-helpers.ts";
import { TimeRange } from "./playback.ts";

export const MediaProfile = z.enum(MEDIA_PROFILES);
export type MediaProfile = z.output<typeof MediaProfile>;

/** A key in the `webflix-media` bucket: `public/...` or `vod/...`, no traversal. */
export const BlobKey = z
  .string()
  .max(1024)
  .regex(/^(?:public|vod)\/(?:[^/]+\/)*[^/]+$/, "Expected a public/ or vod/ blob key")
  .refine((key) => !key.split("/").some((segment) => segment === "." || segment === ".."), {
    message: "Blob keys cannot contain . or .. segments",
  });

const strictlyAscending = (values: readonly number[]) =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? value));

/**
 * One generated image in several widths and formats. `keyTemplate` contains `{width}` and
 * `{format}` (see `blobKeys.titleImageTemplate`). `version` is a short content hash: the API
 * appends `?v=<version>` to CDN URLs so immutable caching never serves stale artwork.
 */
export const ArtworkImage = z.object({
  keyTemplate: BlobKey.refine(
    (key) => key.includes(IMAGE_TEMPLATE_WIDTH) && key.includes(IMAGE_TEMPLATE_FORMAT),
    { message: "keyTemplate must contain {width} and {format}" },
  ),
  widths: z
    .array(z.number().int().positive())
    .min(1)
    .refine(strictlyAscending, { message: "widths must be strictly ascending" }),
  formats: z.array(ImageFormat).min(1),
  aspectRatio: z.number().positive(),
  dominantColor: HexColor,
  thumbhash: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  version: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
});
export type ArtworkImage = z.output<typeof ArtworkImage>;

/** The `ImageSet` DTO for a packaged image: CDN URL template with a cache-busting version. */
export function artworkToImageSet(image: ArtworkImage): ImageSet {
  return {
    template: `${cdnUrlForBlobKey(image.keyTemplate)}?v=${image.version}`,
    widths: image.widths,
    formats: image.formats,
    aspectRatio: image.aspectRatio,
    dominantColor: image.dominantColor,
    thumbhash: image.thumbhash,
  };
}

export const TitleArtwork = z.object({
  titleId: Id,
  backdrop: ArtworkImage,
  card: ArtworkImage,
  poster: ArtworkImage,
  logo: ArtworkImage.nullable(),
});
export type TitleArtwork = z.output<typeof TitleArtwork>;

export const EpisodeStill = z.object({ episodeId: Id, still: ArtworkImage });
export type EpisodeStill = z.output<typeof EpisodeStill>;

export const AvatarImage = z.object({
  avatarId: Id,
  /** `blobKeys.avatar(avatarId)`. */
  key: BlobKey,
  version: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
});
export type AvatarImage = z.output<typeof AvatarImage>;

export const VideoRendition = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Peak bits per second (EXT-X-STREAM-INF BANDWIDTH). */
  bandwidth: z.number().int().positive(),
  codecs: z.string().min(1),
  frameRate: z.number().positive(),
  playlist: BlobKey,
});
export type VideoRendition = z.output<typeof VideoRendition>;

export const AudioRendition = z.object({
  id: z.string().min(1),
  language: LanguageTag,
  label: z.string(),
  codecs: z.string().min(1),
  channels: z.number().int().positive(),
  default: z.boolean(),
  playlist: BlobKey,
});

export const TextTrackFile = z.object({
  id: z.string().min(1),
  language: LanguageTag,
  label: z.string(),
  kind: z.enum(["subtitles", "captions"]),
  default: z.boolean(),
  forced: z.boolean(),
  /** `vod/{assetId}/subs/{lang}.vtt` */
  key: BlobKey,
});
export type TextTrackFile = z.output<typeof TextTrackFile>;

/** Sprite-sheet trick-play; same geometry as the `TrickPlay` DTO, with blob keys. */
export const TrickPlayFiles = z.object({
  intervalSec: z.number().positive(),
  tileWidth: z.number().int().positive(),
  tileHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  sheets: z.array(BlobKey).min(1),
});
export type TrickPlayFiles = z.output<typeof TrickPlayFiles>;

export const PackagedVideoAsset = z.object({
  assetId: Id,
  /** True when the source could not be fetched and a synthetic stand-in was generated. */
  synthetic: z.boolean(),
  durationSec: Seconds,
  /** `blobKeys.vodMaster(assetId)`. */
  master: BlobKey,
  renditions: z.array(VideoRendition).min(1),
  audio: z.array(AudioRendition),
  textTracks: z.array(TextTrackFile),
  trickPlay: TrickPlayFiles.nullable(),
  preview: z
    .object({
      /** `blobKeys.preview(assetId)`. */
      key: BlobKey,
      durationSec: Seconds,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable(),
  markers: z.object({
    intro: TimeRange.nullable(),
    recap: TimeRange.nullable(),
    creditsStartSec: Seconds.nullable(),
  }),
  /** Total bytes under `blobKeys.vodPrefix(assetId)` plus the preview. */
  bytes: z.number().int().nonnegative(),
});
export type PackagedVideoAsset = z.output<typeof PackagedVideoAsset>;

export const MediaManifest = z.object({
  version: z.literal(MEDIA_MANIFEST_VERSION),
  profile: MediaProfile,
  generatedAt: IsoDateTime,
  videoAssets: z.array(PackagedVideoAsset),
  titleArtwork: z.array(TitleArtwork),
  episodeStills: z.array(EpisodeStill),
  avatars: z.array(AvatarImage),
});
export type MediaManifest = z.output<typeof MediaManifest>;
