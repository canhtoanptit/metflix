# Webflix — Design system and web platform

How Webflix looks, moves and is built in `apps/web`. Read with `BLUEPRINT.md` §9 (UX standard). The living reference is the source of truth for visuals: run mock mode and open **`/dev/reference`**.

---

## 1. Identity

| | Decision | Why |
| --- | --- | --- |
| **Accent** | Marquee amber `#ffa31a` (hover `#ffb443`, pressed `#f08f00`), dark text on it | Projector light in a dark auditorium. Warm against cool near-black surfaces (the teal/orange of film grading). Unmistakably not red. Dark-on-amber reads 9.4:1. |
| **Surfaces** | Cool near-black `#0b0c0f` → `surface-4 #30353f` | Artwork carries the colour; chrome stays quiet. |
| **UI type** | Inter (variable, self-hosted, OFL) | Legible at 12–16px, tabular figures for runtimes and progress, Vietnamese coverage for the i18n stretch. |
| **Display type** | Mona Sans (variable width + weight, self-hosted, OFL) | One family, three postures: expanded for the brand and heroes, normal for headings and row titles, condensed for Top 10 numerals. |
| **Wordmark** | `WEBFLIX` in Mona Sans Black at 125% width, amber gradient (`brand-light → brand-deep`) | Outlines extracted once into `packages/ui/src/brand/paths.ts`: the logo never waits for a font. |
| **Mark / app icon** | The W glyph; app icon = dark W on the amber tile | Reads at 16px. `apps/web/public/` holds `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`, a maskable icon and `site.webmanifest`. |

Components: `Wordmark` (`tone` brand/light/dark), `BrandMark`, `AppIcon`, `OriginalLabel` (the "W SERIES" eyebrow). Clear space around the wordmark: half its cap height.

---

## 2. Tokens

All tokens live in `packages/ui/src/styles/tokens.css` as a Tailwind v4 `@theme static` block. Tailwind's default theme is **not** loaded, so only Webflix tokens produce utilities (`bg-red-500` does nothing) and every token also exists as a CSS variable (`var(--color-accent)`).

| Namespace | Examples | Notes |
| --- | --- | --- |
| Colour | `bg-canvas`, `bg-surface-1…4`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `bg-accent`, `text-fg-on-accent`, `border-line`, `border-line-strong`, `bg-glass`, `text-positive`, `text-danger` | AA verified for every text/background pair, including glass over pure-white artwork (`/dev/reference#colour` computes ratios live). |
| Type roles | `type-display-xl/lg/md`, `type-headline`, `type-title-lg`, `type-row-title`, `type-title`, `type-body-lg/body/body-sm`, `type-label`, `type-caption`, `type-overline`, `type-numeral` | One class per role (family, size, weight, width, tracking). Don't add size/weight utilities on top of a role. Display sizes are fluid. |
| Space | 4px grid (`p-4` = 16px); `px-gutter` (4% of width, min 16px), `h-nav`, `gap-row-gap`, `h-control-hero`, `size-avatar-gate` | The gutter aligns nav, billboard copy, row titles and slider peeks. |
| Widths | `max-w-form`, `max-w-prose`, `max-w-dialog-sm/md/lg`, `max-w-detail`, `max-w-page` | |
| Breakpoints | `sm 500`, `md 800`, `lg 1100`, `xl 1400`, `2xl 1920` (px) | Match 2/3/4/5/6 cards per row. Root font scales up at ≥1920/2560/3520px so the UI keeps proportions on TVs and 4K. |
| Radii | `rounded-xs/sm/md/lg/xl/2xl/full`, semantic `rounded-card`, `rounded-control`, `rounded-menu`, `rounded-dialog`, `rounded-avatar` | |
| Elevation | `shadow-xs … shadow-xl`, `shadow-glow` | Raised layers also step up a surface. |
| Motion | `ease-standard/enter/exit/glide/momentum/spring`; `duration-instant/fast/base/slow/slower/fade` utilities; `animate-fade-in/scale-in/slide-up/shimmer/...` | Animate `transform`/`opacity` only. |
| Layers | `z-(--z-sticky)`, `z-(--z-preview)`, `z-(--z-overlay)`, `z-(--z-dropdown)`, `z-(--z-toast)`, `z-(--z-tooltip)` | Menus, selects and popovers stack above overlays: they open from inside dialogs too. |
| Scrims | `scrim-bottom`, `scrim-start`, `scrim-top`, `bg-glow`, `bg-brand-gradient` | For text over artwork. |

**Reduced motion.** Under `prefers-reduced-motion` (or `<html data-motion="reduce">`, which the reference page toggles), all movement durations become 0 and `--duration-fade` stays at 120ms: state changes dissolve instead of moving. Script-driven motion asks `useReducedMotion()` / `prefersReducedMotion()`; the slider pages instantly. `data-motion="full"` forces motion on.

**Reading a time token in script.** Use `readCssTime(name)` / `parseCssTime(value)` from `@webflix/ui` (or the browse app's `durationMs`), never `parseFloat` alone: production CSS is minified, and every time token ships in its shortest form (`450ms` becomes `.45s`, `700ms` becomes `.7s`). A unit-blind reader works against the dev server and reads 0.45 ms in every production build.

**Rules.**
- App and feature code never contain hex/rgb colours or `-[12px]`-style values; `apps/web/test/token-discipline.test.ts` fails the build if they do.
- `className` on a component is for **layout** (margin, width, placement). Appearance comes from props (`variant`, `size`, `tone`). There is no class merging. Components that have overridable defaults (icon, wordmark, mark and spinner sizes, image width, radio-group layout) declare them in the `components` CSS layer, so your utility always wins.

---

## 3. Components (`@webflix/ui`)

Built on Radix primitives (focus management, roles, keyboard) and the tokens above. Every one is in `/dev/reference` in every state.

| Group | Components | Notes |
| --- | --- | --- |
| Brand | `Wordmark`, `BrandMark`, `AppIcon`, `OriginalLabel` | |
| Icons | 77 icons (`PlayIcon`, `PlusIcon`, `ThumbsUpDoubleIcon`, `VolumeMuteIcon`…), `createIcon` | 24px grid, 2px round strokes; transport icons solid. Decorative unless you pass `label`. Each export is tree-shaken (`/* @__PURE__ */`). |
| Actions | `Button` (`primary` = Play, `accent` = brand CTA, `secondary` = frosted over art, `outline`, `ghost`, `danger`, `link`; sizes `sm/md/lg/xl/hero`; `icon`, `iconAfter`, `loading`, `asChild`), `IconButton` (`solid/outline/glass/ghost`, `pressed`, `label` required) | `asChild` renders a router `Link`. `hero` size scales with the viewport (billboard). Tooltips compose around an `IconButton`. |
| Display | `Badge`, `TitleBadge` (contract `TitleCard.badge`), `Top10Badge`, `MaturityBadge`, `QualityBadge`, `Avatar` (`xs…gate`, or `fill` inside a sized parent), `ProgressBar`, `Spinner`, `Skeleton`, `SkeletonText`, `EmptyState`, `ErrorState` | `Top10Badge` and `MaturityBadge` are sized in `em`: set a font size on the parent. |
| Artwork | `ResponsiveImage` | Takes a contract `ImageSet`: AVIF + WebP `srcset`, ThumbHash blur-up over the dominant colour, box reserved from `aspectRatio` (or `fill` a positioned parent). `priority` for the billboard. Always pass `sizes`. Cached images skip the fade. |
| Forms | `TextField` + `PasswordField` (floating label: auth and sign-up), `Field` + `Input` (stacked label: settings), `Select`/`SelectItem`, `Checkbox`, `Switch`, `RadioGroup`/`RadioItem`/`RadioCard` (plan cards), `SegmentedControl`, `PinInput` (profile lock), `SearchInput` | Errors always have an icon and are wired with `aria-describedby`/`aria-invalid`. `PinInput` clears → focus returns to the first box. |
| Overlays | `Dialog` + `DialogContent` (`size` sm/md/lg/detail, `placement` center/top, `bleed`), `DialogFooter`, `ConfirmDialog`, `SheetContent`, `Popover`, `DropdownMenu*`, `Tooltip`, `toast()` | `placement="top"` scrolls the whole overlay (the long detail modal). |
| Disclosure | `Tabs` (`underline`/`pill`), `Accordion` (`faq`/`plain`) | Use `SegmentedControl`, not `Tabs`, when nothing is shown or hidden as panels. |
| Layout | `Gutter`, `PageContainer`, `Stack`, `Cluster`, `Surface`, `Separator`, `SkipLink`, `LazyMount`, `UiProvider` | `LazyMount` mounts rows shortly before they scroll into view; give it a same-size placeholder. |
| Browse | `RowSlider`, `RowSliderSkeleton`, `RowHeaderLink`, `TitleTile`, `TitleTileSkeleton`, `sliderImageSizes` | See §4. |
| Hooks | `useReducedMotion`, `useCanHover`, `useMediaQuery`, `useInView`, `mergeRefs`, `useLatest` | |
| Testing | `@webflix/ui/testing`: `installDomPolyfills`, `setMediaMatcher`, `expectNoA11yViolations` | |

---

## 4. The row slider

```tsx
<RowSlider
  title={row.title}                                   // accessible name of the carousel
  headerAction={<RowExploreLink to="/browse/genre/$slug" params={{ slug }} />}
  items={row.items}
  getKey={(item) => item.id}
  hasMore={row.nextCursor !== null}                   // fetch more instead of wrapping
  onEndReached={() => fetchNextPage()}
  renderItem={(item, { focusProps }) => (
    <TitleTileLink title={item} layout="standard" {...titleOverlayLinkProps(item.id)} {...focusProps} />
  )}
/>
```

- **Paging:** cards per page come from CSS container queries on the slider's own width (2/3/4/5/6), so skeletons, CSS and paging always agree. Pages move with `--ease-glide` over `--duration-slower`; the next card peeks in the right gutter. The Previous arrow and left peek appear after the first move; past the last page the row wraps around forever (virtual indices, stable keys). Arrows and page indicators show on hover or keyboard focus.
- **Touch:** on touch-first devices the row is a native scroll-snap list (platform momentum). On hybrid devices the paged row also takes touch/pen swipes: it follows the finger, rubber-bands before the first page, and settles with `--ease-momentum` at the release speed; a slow short drag springs back.
- **Keyboard and screen readers:** one Tab stop per row (roving tabindex); ←/→ move between cards and page at the edges with focus following; Home/End jump to the page ends. Off-page cards are `inert`. The region is a labelled carousel; page changes are announced ("Showing 7 to 12 of 40").
- **Lazy rendering:** only the previous page, current page, next page and peeks are in the DOM. Combine with `LazyMount` per row and lazy images.

**Hover preview extension points (browse engineer).** The row clips horizontally, so render the preview in a portal (`document.body`) and position it from the event:

| Prop / handle | Gives you |
| --- | --- |
| `onItemHoverIntent(e)` | After `hoverIntentDelay` (default `--delay-hover-intent`, 450ms), mouse only, never while the row is moving or being dragged: `{ item, index, element, rect, edge, position, perPage }`. `edge` is `"start"` / `"end"` for the first/last visible card: expand inward from that side (`transform-origin`). Return `false` to decline (the page is still settling after a scroll): the card then does not count as hovered, so the next pointer movement on it asks again. |
| `onItemHoverEnd(e)` | The pointer left a card, or the row started moving. A hint: keep the preview open while the pointer is on the preview itself. |
| `onPageChange(page, pages)` | Close previews on paging. |
| `ref: RowSliderHandle` | `next()`, `prev()`, `goToPage()`, `getItemElement(index)`, `getVisibleIndices()`, `isAnimating()`, `getMode()`. |
| `data-state="moving"\|"idle"` on the row | For CSS. |

A working minimal preview built only from these is in `apps/web/src/reference/sections/Browse.tsx` (`HoverPreviewRow`). Touch devices open the detail overlay instead (blueprint §9).

The product's preview is `features/browse/preview/`: one preview at a time (`store.ts`), opened from rows and grids, rendered in a portal by the browse shell, positioned by `geometry.ts` (1.5× the card, inward at row edges, inside the gutters, below the nav, above the viewport bottom; the transform origin makes it grow *out of* the card). `hoverIntentDelay` may be a function: after a preview closes the next card opens after 220 ms instead of 450 ms (moving along a row), never during or right after a page scroll (`previewStore.open` declines, and the card asks again on the next pointer movement; a pointer that stays still never opens one). Pointer movement on a card also starts intent (a card that slid under a resting pointer).

`TitleTile` draws every contract row layout: `standard` (16:9 card, Original mark, Top 10 corner badge, ribbon for `new`/`new-episodes`/`leaving-soon`), `tall` (2:3 poster), `ranked` (outlined condensed numeral + poster) and `continue` (card + progress). It is an anchor: wrap with `createLink` (the app exports `TitleTileLink`).

---

## 5. App platform (`apps/web`)

### Ownership

```
src/
  main.tsx                    platform
  app/                        platform: api client, query client/keys/queries, session, router
                              (root, guards, layouts, tree), overlay, document titles, errors,
                              links, dev toolbar, ScreenPlaceholder
  features/
    browse/                   BROWSE ENGINEER
      routes.tsx              /browse, /browse/series|movies|new-popular, /browse/genre/$slug,
                              /my-list, /search, /title/$titleId (→ overlay)
      shell/  home/  genre/  my-list/  search/  title/  notifications/  library/
    member/                   MEMBER + WATCH ENGINEER
      routes.tsx              /, /login, /logout, /signup (+ /plan, /payment, /profile),
                              /profiles, /profiles/manage, /profiles/new,
                              /profiles/$profileId/edit, /account (+ /plan, /cancel,
                              /devices, /security), /account/activity
      marketing/  auth/  signup/  profiles/  account/
    watch/                    MEMBER + WATCH ENGINEER — /watch/$titleId?episode=&t=
  mocks/  reference/          platform (dev only)
```

Each engineer edits only their folders. `app/router/tree.ts` plugs `browseRoutes`, `memberRoutes` and `watchRoutes` into the guard layouts and never needs editing. Placeholders marked **STARTER** (browse shell, browse page, detail overlay, sign in, sign out, profile gate) already work end to end in mock mode; replace their design freely.

### Adding a screen

1. Create the component in your folder (`features/browse/search/SearchPage.tsx`).
2. Declare the route in your `routes.tsx` under the right parent: `profileLayout` (needs a profile), `accountLayout` (signed in), `guestLayout` (signed out only), `publicLayout` (no guard, or a guard in `beforeLoad`: `requireGuest` / `requireAccount` / `requireProfile`), or your own layout route. Add it to your exported group.
3. `component: lazyRouteComponent(() => import("./X.tsx"), "X")` — one chunk per screen.
4. `staticData: { title: "Search" }` sets the document title ("Search · Webflix"); dynamic titles use `useDocumentTitle(name)`.
5. Search params: `validateSearch: (s) => optionalSearch({ q: searchParam.string(s.q) })`. Always go through `optionalSearch`/`searchParam` — the router merges validated values over the raw URL, so a validator must overwrite (not omit) rejected values. Read with `getRouteApi("<route id>").useSearch()`.

### Data

- **Client:** `api()` is the typed contract client (same origin; mock in mock mode).
- **Reads:** `useQuery(queries.title(id))`, `useInfiniteQuery(queries.browse("home"))` — options for every GET endpoint are in `app/query/queries.ts`; keys in `app/query/keys.ts` (`qk.profile.*` is dropped on profile switch, `qk.account.*` on sign-out). Prefetch in a route `loader` or on intent with `queryClient.prefetchQuery(...)` when it helps; screens render skeletons with the final geometry, not route-level spinners.
- **Mutations:** `useMutation` with `api()`. Optimistic pattern: `onMutate: () => optimisticUpdate(queryClient, qk.profile.all(), (d) => patchTitleViewer(d, id, { inMyList: true }))`, `onError: (_e, _v, rollback) => rollback?.()`, `onSettled: invalidate`. Reference: `features/browse/library/useMyListToggle.ts`.
- **Errors:** 4xx are never retried; network/5xx retry twice. `unauthenticated`/`profile_required` anywhere reset the session and the guards redirect. A failed background refetch toasts once; first loads render `ErrorState` with `describeError(error)` copy; mutations toast unless they pass `meta: { silent: true }` or their own `onError`. Contain section failures with `SectionErrorBoundary`.
- **Session transitions:** after `login`/`signup`/`selectProfile`/`clearProfile`, call `const applySession = useApplySession(); await applySession(session)` then navigate. Sign-out: `sessionCache.signOut(queryClient)` + `router.invalidate()` (see `LogoutPage`). Read with `useSession()`, `useAuthenticatedSession()`, `useActiveProfile()`.

### The title overlay convention

`?title=<titleId>` on any profile route opens the detail modal over that page; the browse shell renders it. Links: `<TitleTileLink {...titleOverlayLinkProps(id)} />` (real `href`, no scroll jump, records the card rect). Code: `const { titleId, open, close } = useTitleOverlay()`; `open(id, { origin: element })`, `getTitleOverlayOrigin()` for a grow-from-card animation. Back closes an overlay we opened; closing a shared link replaces the URL. Opening another title from the overlay stacks. `/title/<id>` redirects to `/browse?title=<id>`.

### Code-split interaction layers

Layers that must appear on the next frame once asked for (the detail overlay, the hover preview, navigation menus) are not `React.lazy`: a lazy component suspends on its first render even when its code is loaded, and React throttles revealing suspended content by about 300 ms. `features/browse/common/modules.ts` (`preloadable` + `useModule`) preloads them on idle or intent and renders them directly once loaded. Menus render a stand-in trigger with the same look until then (`features/browse/shell/intent.ts`). The overlay's grow-from-card motion starts from its panel's ref callback, because Radix mounts portal content one render after the dialog.

### Other conventions

Scroll restoration is per history entry (router `scrollRestoration`); opening the overlay never scrolls. Route chunks preload on link hover/focus (`defaultPreload: "intent"`). The root shows a brand splash (also inlined in `index.html`) while the session bootstraps; slow navigations show a thin amber progress bar.

---

## 6. Running it

| What | Command | Notes |
| --- | --- | --- |
| Mock mode (no backend) | `pnpm --filter @webflix/web dev:mock` or `make web-mock` | API answered in the browser from a 56-title catalogue (`src/mocks/`), responses validated against the contract; artwork generated as SVG at the real `/cdn/img/...` URLs. Demo login `demo@webflix.dev` / `webflix-demo`; Theo's PIN is `1234`. Bottom-left **Mock** button: switch session (signed out / no profile / Mara), latency, failing endpoints. `?mock-session=anonymous\|account\|profile` resets the mock on load. |
| Real API | `pnpm --filter @webflix/web dev` (or `pnpm dev` for API + web) | Vite proxies `/api`, `/media`, `/cdn` to `WEBFLIX_API_ORIGIN` (default `http://localhost:4000`). Port: `WEB_PORT`. |
| Reference page | open `/dev/reference` in either dev mode | Dev server and mock builds only; absent from production builds. |
| Screenshots | `make screenshots ROUTES="/browse /dev/reference" WIDTHS=390,834,1440 SESSION=profile` | Starts mock mode on `E2E_MOCK_PORT` (4210) unless `BASE_URL` is set; scrolls to load lazy content; hides dev chrome; writes to `e2e/screenshots/<timestamp>/`. |
| UI e2e (mock) | `make e2e-mock` | Guards, overlay, slider interaction (real transitions, keyboard, resize, swipe), axe incl. colour contrast. |
| E2E against a mode | `make e2e TARGET=dev\|k8s\|cf` | Uses `e2e/tests`. |
| Tests | `pnpm --filter @webflix/ui test`, `pnpm --filter @webflix/web test` | Testing Library + jsdom with explicit cleanup; axe via `expectNoA11yViolations`. |

**Bundle** (production build, gzip, JS): entry 121 KB (React DOM ~63, TanStack Router ~22, Query ~9.5); landing 125, watch 125, sign in 131, profile gate 142, browse 158 (menus, the detail overlay and the hover preview load on idle or intent: +48 and +33). Fonts load per subset on demand; the two Latin files are preloaded. Re-measure from `dist/.vite/manifest.json` after `pnpm --filter @webflix/web build`.
