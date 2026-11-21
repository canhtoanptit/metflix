import * as z from "zod";
import { Cursor, Id, IsoDateTime } from "./common.ts";
import { NOTIFICATION_KINDS } from "./constants.ts";
import { ImageSet } from "./media.ts";
import { EpisodeRef, RatingValue, TitleCard, TitleType } from "./titles.ts";

export const MyListPage = z
  .object({ items: z.array(TitleCard), nextCursor: Cursor.nullable() })
  .meta({ id: "MyListPage" });
export type MyListPage = z.output<typeof MyListPage>;

export const RateTitleBody = z.object({ value: RatingValue }).meta({ id: "RateTitleBody" });
export type RateTitleBody = z.input<typeof RateTitleBody>;

/** One row of "Viewing activity". */
export const HistoryEntry = z
  .object({
    id: Id,
    watchedAt: IsoDateTime,
    title: z.object({ id: Id, name: z.string(), type: TitleType }),
    episode: EpisodeRef.nullable(),
  })
  .meta({ id: "HistoryEntry" });
export type HistoryEntry = z.output<typeof HistoryEntry>;

export const HistoryPage = z
  .object({ items: z.array(HistoryEntry), nextCursor: Cursor.nullable() })
  .meta({ id: "HistoryPage" });
export type HistoryPage = z.output<typeof HistoryPage>;

export const NotificationKind = z.enum(NOTIFICATION_KINDS).meta({ id: "NotificationKind" });
export type NotificationKind = z.output<typeof NotificationKind>;

export const Notification = z
  .object({
    id: Id,
    kind: NotificationKind,
    createdAt: IsoDateTime,
    readAt: IsoDateTime.nullable(),
    headline: z.string(),
    body: z.string(),
    /** The title the notification is about; opening it shows the detail modal. */
    title: z.object({ id: Id, name: z.string() }).nullable(),
    image: ImageSet.nullable(),
  })
  .meta({ id: "Notification" });
export type Notification = z.output<typeof Notification>;

export const NotificationList = z
  .object({
    items: z.array(Notification),
    unreadCount: z.number().int().nonnegative(),
  })
  .meta({ id: "NotificationList" });
export type NotificationList = z.output<typeof NotificationList>;

/** Mark the given notifications read; omit `ids` to mark everything read. */
export const MarkNotificationsReadBody = z
  .object({ ids: z.array(Id).min(1).max(100).optional() })
  .meta({ id: "MarkNotificationsReadBody" });
export type MarkNotificationsReadBody = z.input<typeof MarkNotificationsReadBody>;
