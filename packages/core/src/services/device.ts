import type { DeviceType } from "../repositories/records.ts";

/**
 * A human label ("Chrome on macOS") and a coarse type for the Devices list and the
 * "too many screens" page. Heuristic on purpose: it only needs to help a person recognise
 * their own devices.
 */
export function describeDevice(userAgent: string | null | undefined): {
  label: string;
  type: DeviceType;
} {
  const ua = userAgent ?? "";
  if (ua === "") return { label: "Unknown device", type: "unknown" };

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua) || /CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl\//i.test(ua)
              ? "curl"
              : /node|undici/i.test(ua)
                ? "Node.js"
                : /Playwright|HeadlessChrome/.test(ua)
                  ? "Headless browser"
                  : "Browser";

  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : /SmartTV|Tizen|Web0S|AppleTV|GoogleTV/i.test(ua)
                  ? "TV"
                  : null;

  const type: DeviceType = /SmartTV|Tizen|Web0S|AppleTV|GoogleTV/i.test(ua)
    ? "tv"
    : /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /iPhone|Mobile/.test(ua)
        ? "mobile"
        : os
          ? "desktop"
          : "unknown";

  return { label: os ? `${browser} on ${os}` : browser, type };
}
