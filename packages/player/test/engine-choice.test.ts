import { describe, expect, it } from "vitest";
import { chooseEngine, isHlsUrl } from "../src/core/engine-choice.ts";

describe("engine choice", () => {
  const both = { mse: true, nativeHls: true };
  it("recognises HLS URLs, including signed ones with queries", () => {
    expect(isHlsUrl("/media/tok/vod/a/master.m3u8")).toBe(true);
    expect(isHlsUrl("https://x.test/a.m3u8?token=1#t=10")).toBe(true);
    expect(isHlsUrl("/cdn/previews/a/preview.mp4")).toBe(false);
  });
  it("plays progressive files natively", () => {
    expect(chooseEngine("/a.mp4", "auto", { mse: false, nativeHls: false })).toBe("progressive");
  });
  it("prefers hls.js wherever MSE exists, even if the browser claims native HLS", () => {
    expect(chooseEngine("/a.m3u8", "auto", both)).toBe("hls.js");
  });
  it("falls back to native HLS without MSE (older iOS)", () => {
    expect(chooseEngine("/a.m3u8", "auto", { mse: false, nativeHls: true })).toBe("native");
  });
  it("honours an explicit preference when possible", () => {
    expect(chooseEngine("/a.m3u8", "native", both)).toBe("native");
    expect(chooseEngine("/a.m3u8", "native", { mse: true, nativeHls: false })).toBe("hls.js");
    expect(chooseEngine("/a.m3u8", "hls.js", { mse: false, nativeHls: true })).toBe("native");
  });
  it("returns null when nothing can play HLS", () => {
    expect(chooseEngine("/a.m3u8", "auto", { mse: false, nativeHls: false })).toBeNull();
  });
});
