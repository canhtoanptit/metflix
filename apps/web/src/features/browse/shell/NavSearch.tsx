import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { Button, IconButton, SearchIcon, SearchInput } from "@webflix/ui";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { searchParam } from "../../../app/router/search.ts";
import { canAnimate, durationMs, easing } from "../common/motion.ts";

const SEARCH_PATH = "/search";
/** Typing settles into the URL after this pause (results and history stay calm). */
export const SEARCH_DEBOUNCE_MS = 220;

export interface NavSearchProps {
  /**
   * `inline`: the icon expands into a field in place (tablet and desktop).
   * `cover`: the field covers the whole top bar, with Cancel (phones).
   */
  variant: "inline" | "cover";
}

/**
 * The navigation search. The field lives in the shell, so it is never remounted while the
 * results page updates: focus and caret stay put. Typing is instant locally and reaches the URL
 * (`/search?q=`) after a short pause: the first keystroke pushes a history entry (Back returns
 * to where you were), later ones replace it. Clearing the field returns to that page; Escape
 * clears, and a second Escape folds the field away.
 */
export function NavSearch({ variant }: NavSearchProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const onSearchPage = useRouterState({ select: (s) => s.location.pathname === SEARCH_PATH });
  const urlQuery = useRouterState({
    select: (s) =>
      s.location.pathname === SEARCH_PATH
        ? (searchParam.string((s.location.search as Record<string, unknown>).q) ?? "")
        : "",
  });
  const [value, setValue] = useState(urlQuery);
  const [expanded, setExpanded] = useState(onSearchPage);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLElement>(null);
  /** The query this field last wrote to the URL; anything else in the URL came from elsewhere. */
  const written = useRef(urlQuery);
  /** We pushed the /search entry, so leaving search can go Back instead of guessing. */
  const pushed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusAfterExpand = useRef(false);

  const cancelPending = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelPending, []);

  // Adopt URL changes made elsewhere: Back/Forward, suggestion links, the phone tab bar.
  useEffect(() => {
    if (urlQuery === written.current) return;
    cancelPending();
    written.current = urlQuery;
    setValue(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (onSearchPage) {
      setExpanded(true);
      // Arriving on an empty search page (tab bar, direct link): ready to type.
      if (!written.current && document.activeElement !== inputRef.current) {
        focusAfterExpand.current = true;
      }
      return;
    }
    pushed.current = false;
    // Left search by navigating elsewhere: fold away, unless the person is typing in it.
    if (document.activeElement !== inputRef.current) {
      cancelPending();
      written.current = "";
      setValue("");
      setExpanded(false);
    }
  }, [onSearchPage]);

  useLayoutEffect(() => {
    if (!expanded) return;
    if (focusAfterExpand.current) {
      focusAfterExpand.current = false;
      inputRef.current?.focus();
    }
    const field = fieldRef.current;
    if (canAnimate(field)) {
      field.animate(
        [
          {
            opacity: 0,
            transform: variant === "cover" ? "translateY(-0.5rem)" : "translateX(1rem)",
          },
          { opacity: 1, transform: "none" },
        ],
        { duration: durationMs("--duration-base", 240), easing: easing("--ease-standard") },
      );
    }
  }, [expanded, variant]);

  const leaveSearch = () => {
    if (router.state.location.pathname !== SEARCH_PATH) return;
    if (pushed.current) {
      pushed.current = false;
      router.history.back();
    } else {
      void navigate({ to: "/browse", replace: true });
    }
  };

  const commit = (raw: string) => {
    cancelPending();
    const q = raw.trim();
    if (q === written.current) return;
    written.current = q;
    if (!q) {
      leaveSearch();
      return;
    }
    if (router.state.location.pathname === SEARCH_PATH) {
      void navigate({ to: SEARCH_PATH, search: { q }, replace: true, resetScroll: false });
    } else {
      pushed.current = true;
      void navigate({ to: SEARCH_PATH, search: { q } });
    }
  };

  const onValueChange = (next: string) => {
    setValue(next);
    cancelPending();
    // Emptying the field leaves search at once; typing settles first.
    if (!next.trim()) commit("");
    else timer.current = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
  };

  const collapse = () => {
    cancelPending();
    setExpanded(false);
    requestAnimationFrame(() => toggleRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (value) {
        setValue("");
        commit("");
      } else {
        collapse();
      }
    } else if (event.key === "Enter") {
      commit(value);
      if (variant === "cover") inputRef.current?.blur();
    }
  };

  const expand = () => {
    focusAfterExpand.current = true;
    setExpanded(true);
  };

  if (!expanded) {
    return (
      <IconButton
        ref={toggleRef}
        label="Search"
        icon={SearchIcon}
        onClick={expand}
        aria-expanded={false}
      />
    );
  }

  const field = (
    <SearchInput
      ref={inputRef}
      value={value}
      onValueChange={onValueChange}
      label="Search titles, people and genres"
      placeholder="Titles, people, genres"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const stillInside = event.currentTarget
          .closest("search")
          ?.contains(event.relatedTarget as Node | null);
        if (!stillInside && !value.trim() && !onSearchPage) setExpanded(false);
      }}
      className="w-full"
    />
  );

  if (variant === "cover") {
    return (
      <>
        {/* Keeps the bar's layout while the field covers it. */}
        <span aria-hidden className="size-10" />
        <search
          ref={fieldRef}
          className="absolute inset-0 z-(--z-raised) flex items-center gap-2 bg-canvas px-gutter"
        >
          {field}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setValue("");
              commit("");
              setExpanded(false);
            }}
          >
            Cancel
          </Button>
        </search>
      </>
    );
  }

  return (
    <search ref={fieldRef} className="w-56 lg:w-72">
      {field}
    </search>
  );
}
