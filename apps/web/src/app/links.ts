import { createLink } from "@tanstack/react-router";
import { RowHeaderLink, TitleTile } from "@webflix/ui";

/**
 * Design-system anchors as typed router links (`to`, `params`, `search`, preloading).
 *
 *   <TitleTileLink title={card} layout="standard" {...titleOverlayLinkProps(card.id)} />
 *   <RowExploreLink to="/browse/genre/$slug" params={{ slug }} />
 */
export const TitleTileLink = createLink(TitleTile);
export const RowExploreLink = createLink(RowHeaderLink);
