/**
 * Preload the two Latin font files every first paint needs (UI text and display), so text does
 * not swap fonts after the CSS arrives. Build only: the hashed file names exist in the bundle.
 */
import type { Plugin } from "vite";

const CRITICAL_FONTS = ["inter-latin-wght-normal", "mona-sans-latin-standard-normal"];

export function fontPreloadPlugin(): Plugin {
  return {
    name: "webflix-font-preload",
    apply: "build",
    transformIndexHtml(_html, context) {
      const bundle = context.bundle ?? {};
      return Object.values(bundle)
        .filter(
          (file) =>
            file.type === "asset" &&
            file.fileName.endsWith(".woff2") &&
            CRITICAL_FONTS.some((name) => file.fileName.includes(name)),
        )
        .map((file) => ({
          tag: "link",
          attrs: {
            rel: "preload",
            as: "font",
            type: "font/woff2",
            href: `/${file.fileName}`,
            crossorigin: "",
          },
          injectTo: "head" as const,
        }));
    },
  };
}
