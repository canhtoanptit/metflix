import { describe, expect, it } from "vitest";
import { isEditableTarget, resolveKeyCommand } from "../src/core/keymap.ts";

describe("resolveKeyCommand (blueprint §9 keyboard map)", () => {
  it.each([
    [" ", { type: "togglePlay" }],
    ["k", { type: "togglePlay" }],
    ["K", { type: "togglePlay" }],
    ["ArrowLeft", { type: "seekBy", seconds: -10 }],
    ["ArrowRight", { type: "seekBy", seconds: 10 }],
    ["j", { type: "seekBy", seconds: -10 }],
    ["l", { type: "seekBy", seconds: 10 }],
    ["ArrowUp", { type: "volumeBy", delta: 0.1 }],
    ["ArrowDown", { type: "volumeBy", delta: -0.1 }],
    ["m", { type: "toggleMute" }],
    ["f", { type: "toggleFullscreen" }],
    ["c", { type: "toggleCaptions" }],
    ["Escape", { type: "escape" }],
    ["Home", { type: "seekToStart" }],
    ["End", { type: "seekToEnd" }],
    ["s", { type: "skipMoment" }],
    ["p", { type: "togglePip" }],
    [">", { type: "rateStep", direction: 1 }],
    ["<", { type: "rateStep", direction: -1 }],
  ])("%j", (key, command) => {
    expect(resolveKeyCommand({ key })).toEqual(command);
  });

  it("maps number keys to tenths of the duration", () => {
    expect(resolveKeyCommand({ key: "0" })).toEqual({ type: "seekToFraction", fraction: 0 });
    expect(resolveKeyCommand({ key: "5" })).toEqual({ type: "seekToFraction", fraction: 0.5 });
    expect(resolveKeyCommand({ key: "9" })).toEqual({ type: "seekToFraction", fraction: 0.9 });
  });

  it("handles shifted shortcuts", () => {
    expect(resolveKeyCommand({ key: "N", shiftKey: true })).toEqual({ type: "nextEpisode" });
    expect(resolveKeyCommand({ key: "D", shiftKey: true })).toEqual({ type: "toggleStats" });
    expect(resolveKeyCommand({ key: ".", shiftKey: true })).toEqual({
      type: "rateStep",
      direction: 1,
    });
    expect(resolveKeyCommand({ key: ",", shiftKey: true })).toEqual({
      type: "rateStep",
      direction: -1,
    });
    expect(resolveKeyCommand({ key: "F", shiftKey: true })).toBeNull();
  });

  it("leaves browser and OS shortcuts alone", () => {
    expect(resolveKeyCommand({ key: "f", metaKey: true })).toBeNull();
    expect(resolveKeyCommand({ key: "l", ctrlKey: true })).toBeNull();
    expect(resolveKeyCommand({ key: "ArrowLeft", altKey: true })).toBeNull();
  });

  it("repeats seeks and volume but never toggles", () => {
    expect(resolveKeyCommand({ key: "ArrowRight", repeat: true })).toEqual({
      type: "seekBy",
      seconds: 10,
    });
    expect(resolveKeyCommand({ key: "ArrowUp", repeat: true })).toEqual({
      type: "volumeBy",
      delta: 0.1,
    });
    expect(resolveKeyCommand({ key: " ", repeat: true })).toBeNull();
    expect(resolveKeyCommand({ key: "f", repeat: true })).toBeNull();
  });

  it("ignores unmapped keys", () => {
    expect(resolveKeyCommand({ key: "q" })).toBeNull();
    expect(resolveKeyCommand({ key: "Tab" })).toBeNull();
  });
});

describe("isEditableTarget", () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) =>
    ({ tagName, ...extra }) as unknown as EventTarget;
  it("detects typing targets", () => {
    expect(isEditableTarget(el("TEXTAREA"))).toBe(true);
    expect(isEditableTarget(el("SELECT"))).toBe(true);
    expect(isEditableTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isEditableTarget(el("INPUT", { type: "search" }))).toBe(true);
    expect(isEditableTarget(el("DIV", { isContentEditable: true }))).toBe(true);
  });
  it("lets the player handle keys elsewhere", () => {
    expect(isEditableTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isEditableTarget(el("BUTTON"))).toBe(false);
    expect(isEditableTarget(el("DIV"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
