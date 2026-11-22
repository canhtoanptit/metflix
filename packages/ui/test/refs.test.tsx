/**
 * `mergeRefs` and `useMergedRefs` with refs that start something (React 19 callback refs that
 * return a cleanup): every start is stopped, and a stable merged ref does not start over on each
 * render.
 */
import { act, render } from "@testing-library/react";
import { type RefCallback, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { mergeRefs, useMergedRefs } from "../src/index.ts";

function observingRef<T extends Element>(log: string[]): RefCallback<T> {
  return (node) => {
    if (!node) return;
    log.push("start");
    return () => {
      log.push("stop");
    };
  };
}

describe("mergeRefs", () => {
  it("keeps a callback ref's cleanup, and empties object refs", () => {
    const log: string[] = [];
    const objectRef = { current: null as HTMLDivElement | null };
    const plain = vi.fn();
    const { unmount } = render(
      <div ref={mergeRefs(observingRef<HTMLDivElement>(log), objectRef, plain)} />,
    );
    expect(log).toEqual(["start"]);
    expect(objectRef.current).toBeInstanceOf(HTMLDivElement);
    unmount();
    expect(log).toEqual(["start", "stop"]);
    expect(objectRef.current).toBeNull();
    expect(plain).toHaveBeenLastCalledWith(null);
  });

  it("re-attaches on every render when used inline (balanced: every start is stopped)", () => {
    const log: string[] = [];
    const observe = observingRef<HTMLButtonElement>(log);
    function Inline() {
      const [count, setCount] = useState(0);
      return <button type="button" ref={mergeRefs(observe)} onClick={() => setCount(count + 1)} />;
    }
    const { getByRole, unmount } = render(<Inline />);
    act(() => getByRole("button").click());
    unmount();
    expect(log.filter((entry) => entry === "start").length).toBe(
      log.filter((entry) => entry === "stop").length,
    );
  });
});

describe("useMergedRefs", () => {
  it("attaches once across renders while its refs stay the same", () => {
    const log: string[] = [];
    const observe = observingRef<HTMLButtonElement>(log);
    function Stable() {
      const own = useRef<HTMLButtonElement>(null);
      const [count, setCount] = useState(0);
      const ref = useMergedRefs<HTMLButtonElement>(own, observe);
      return (
        <button type="button" ref={ref} onClick={() => setCount(count + 1)}>
          {count}
        </button>
      );
    }
    const { getByRole, unmount } = render(<Stable />);
    act(() => getByRole("button").click());
    act(() => getByRole("button").click());
    expect(getByRole("button")).toHaveTextContent("2");
    expect(log).toEqual(["start"]);
    unmount();
    expect(log).toEqual(["start", "stop"]);
  });
});
