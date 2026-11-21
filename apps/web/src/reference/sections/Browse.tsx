import type { TitleCard } from "@webflix/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  IconButton,
  MaturityBadge,
  PlayIcon,
  PlusIcon,
  ResponsiveImage,
  RowHeaderLink,
  RowSlider,
  type RowSliderHoverEvent,
  RowSliderSkeleton,
  ThumbsUpIcon,
  TitleTile,
} from "@webflix/ui";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cards, continueItems, originals, ranked } from "../data.ts";
import { Section } from "../Specimen.tsx";

const noop = (event: { preventDefault: () => void }) => event.preventDefault();

/**
 * A minimal hover preview built only on the slider's extension points: it lives in a portal
 * (outside the row's clip), grows from the card's rect and expands inward at page edges.
 */
function HoverPreviewRow() {
  const [hover, setHover] = useState<RowSliderHoverEvent<TitleCard> | null>(null);
  const [log, setLog] = useState("Hover a card for ~0.5 s");
  const overPreview = useRef(false);
  const close = () => setHover(null);

  const preview = hover
    ? (() => {
        const scale = 1.5;
        const width = hover.rect.width * scale;
        const left =
          hover.edge === "start"
            ? hover.rect.left
            : hover.edge === "end"
              ? hover.rect.right - width
              : hover.rect.left - (width - hover.rect.width) / 2;
        const origin =
          hover.edge === "start"
            ? "left center"
            : hover.edge === "end"
              ? "right center"
              : "center center";
        return createPortal(
          <div
            className="absolute z-(--z-preview) overflow-hidden rounded-lg bg-surface-2 shadow-xl animate-scale-in"
            style={{
              top: hover.rect.top + window.scrollY - hover.rect.height * 0.35,
              left: left + window.scrollX,
              width,
              transformOrigin: origin,
              ["--scale-from" as string]: String(1 / scale),
            }}
            onPointerEnter={() => {
              overPreview.current = true;
            }}
            onPointerLeave={() => {
              overPreview.current = false;
              close();
            }}
          >
            <ResponsiveImage image={hover.item.images.card} alt="" sizes="30vw" />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2">
                <IconButton label="Play" icon={PlayIcon} variant="solid" size="sm" />
                <IconButton
                  label={hover.item.viewer.inMyList ? "Remove from My List" : "Add to My List"}
                  icon={hover.item.viewer.inMyList ? CheckIcon : PlusIcon}
                  variant="outline"
                  size="sm"
                />
                <IconButton label="Rate" icon={ThumbsUpIcon} variant="outline" size="sm" />
                <IconButton
                  label="More info"
                  icon={ChevronDownIcon}
                  variant="outline"
                  size="sm"
                  className="ms-auto"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 type-body-sm text-fg-muted">
                {hover.item.matchScore !== null ? (
                  <span className="font-semibold text-positive">
                    {hover.item.matchScore}% match
                  </span>
                ) : null}
                <MaturityBadge rating={hover.item.maturity} />
                <span>
                  {hover.item.type === "series"
                    ? `${hover.item.seasonCount} season${hover.item.seasonCount === 1 ? "" : "s"}`
                    : `${Math.round((hover.item.runtimeSec ?? 0) / 60)}m`}
                </span>
              </div>
              <p className="type-body-sm text-fg">
                {hover.item.genres.map((genre) => genre.name).join(" · ")}
              </p>
            </div>
          </div>,
          document.body,
        );
      })()
    : null;

  return (
    <>
      <RowSlider
        title="Hover preview (extension point demo)"
        items={cards.slice(20, 44)}
        getKey={(item) => item.id}
        onItemHoverIntent={(event) => {
          setHover(event);
          setLog(
            `intent: "${event.item.name}" · index ${event.index} · edge ${event.edge ?? "none"} · position ${event.position + 1}/${event.perPage} · rect ${Math.round(event.rect.width)}×${Math.round(event.rect.height)} at (${Math.round(event.rect.left)}, ${Math.round(event.rect.top)})`,
          );
        }}
        onItemHoverEnd={() => {
          // Give the pointer time to travel onto the preview before closing.
          setTimeout(() => {
            if (!overPreview.current) close();
          }, 120);
        }}
        onPageChange={(page, pages) => {
          close();
          setLog(`page ${page + 1} of ${pages}`);
        }}
        renderItem={(item, { focusProps }) => (
          <TitleTile
            title={item}
            layout="standard"
            href={`?title=${item.id}`}
            onClick={noop}
            {...focusProps}
          />
        )}
      />
      <p
        className="px-gutter font-mono text-xs text-fg-subtle"
        aria-live="polite"
        data-testid="hover-log"
      >
        {log}
      </p>
      {preview}
    </>
  );
}

export function Browse() {
  const [pageLog, setPageLog] = useState("");
  return (
    <Section
      id="browse"
      title="Browse rows"
      bleed
      description="RowSlider pages with a long glide, peeks at both edges, shows arrows and page indicators on hover, wraps around after the first move, swipes with momentum on touch, keeps one Tab stop per row (arrow keys inside, focus follows paging) and renders only ~3 pages. On touch-first devices it becomes a native scroll-snap row."
    >
      <div className="flex flex-col gap-row-gap">
        <RowSlider
          id="ref-standard"
          title="Trending Now"
          headerAction={<RowHeaderLink href="#browse" onClick={noop} />}
          items={cards}
          getKey={(item) => item.id}
          onPageChange={(page, pages) => setPageLog(`Trending Now: page ${page + 1} of ${pages}`)}
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item}
              layout="standard"
              href={`?title=${item.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <RowSlider
          id="ref-continue"
          title="Continue Watching for Mara"
          layout="continue"
          items={continueItems}
          getKey={(item) => item.title.id}
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item.title}
              layout="continue"
              progress={item.progress}
              episode={item.episode}
              href={`?title=${item.title.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <RowSlider
          id="ref-ranked"
          title="Top 10 Movies Today"
          layout="ranked"
          items={ranked}
          getKey={(item) => item.title.id}
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item.title}
              layout="ranked"
              rank={item.rank}
              href={`?title=${item.title.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <RowSlider
          id="ref-tall"
          title="Only on Webflix"
          layout="tall"
          items={originals}
          getKey={(item) => item.id}
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item}
              layout="tall"
              href={`?title=${item.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <RowSlider
          id="ref-controls"
          title="Controls forced visible (for review)"
          items={cards.slice(12, 40)}
          getKey={(item) => item.id}
          forceControls
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item}
              layout="standard"
              href={`?title=${item.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <RowSlider
          id="ref-short"
          title="Short row (no paging)"
          items={cards.slice(40, 43)}
          getKey={(item) => item.id}
          renderItem={(item, { focusProps }) => (
            <TitleTile
              title={item}
              layout="standard"
              href={`?title=${item.id}`}
              onClick={noop}
              {...focusProps}
            />
          )}
        />
        <HoverPreviewRow />
        <p
          className="px-gutter font-mono text-xs text-fg-subtle"
          aria-live="polite"
          data-testid="page-log"
        >
          {pageLog || "Page changes are reported through onPageChange"}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-gutter">
          <h3 className="type-label text-fg">Loading rows</h3>
          <p className="type-caption text-fg-subtle">
            Same container queries, gutter and gap as the real rows: zero layout shift when data
            arrives.
          </p>
        </div>
        <div className="flex w-full flex-col gap-row-gap">
          <RowSliderSkeleton layout="standard" />
          <RowSliderSkeleton layout="ranked" title="Top 10 Series Today" />
          <RowSliderSkeleton layout="tall" />
        </div>
      </div>
    </Section>
  );
}
