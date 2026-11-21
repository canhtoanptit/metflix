/**
 * Fullscreen and picture-in-picture across the standard APIs, WebKit's prefixed element
 * fullscreen (iPad, older Safari) and iPhone's video-only fullscreen.
 */

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };

/** iPhone Safari: only the video element can go fullscreen, with the system player. */
export type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsFullscreen?: boolean;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture" | "fullscreen") => void;
  webkitPresentationMode?: "inline" | "picture-in-picture" | "fullscreen";
};

export function fullscreenElement(doc: Document): Element | null {
  const d = doc as FullscreenDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function canFullscreen(root: HTMLElement, video: HTMLVideoElement): boolean {
  const d = root.ownerDocument as FullscreenDocument;
  if (d.fullscreenEnabled || d.webkitFullscreenEnabled) return true;
  return (video as WebKitVideo).webkitSupportsFullscreen === true;
}

export function isFullscreen(root: HTMLElement, video: HTMLVideoElement): boolean {
  return (
    fullscreenElement(root.ownerDocument) === root ||
    (video as WebKitVideo).webkitDisplayingFullscreen === true
  );
}

export async function enterFullscreen(root: HTMLElement, video: HTMLVideoElement): Promise<void> {
  const d = root.ownerDocument as FullscreenDocument;
  const el = root as FullscreenElement;
  if (d.fullscreenEnabled && el.requestFullscreen) {
    await el.requestFullscreen({ navigationUI: "hide" });
  } else if (d.webkitFullscreenEnabled && el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    (video as WebKitVideo).webkitEnterFullscreen?.();
    return;
  }
  // Phones: landscape fills the screen. Best effort; most browsers refuse outside fullscreen.
  const orientation = globalThis.screen?.orientation as
    | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
    | undefined;
  if (orientation?.lock && matchMedia?.("(pointer: coarse)").matches) {
    orientation.lock("landscape").catch(() => {});
  }
}

export async function exitFullscreen(root: HTMLElement, video: HTMLVideoElement): Promise<void> {
  const d = root.ownerDocument as FullscreenDocument;
  const orientation = globalThis.screen?.orientation as
    | (ScreenOrientation & { unlock?: () => void })
    | undefined;
  try {
    orientation?.unlock?.();
  } catch {
    // Not locked / not supported.
  }
  if (d.fullscreenElement && d.exitFullscreen) {
    await d.exitFullscreen();
  } else if (d.webkitFullscreenElement && d.webkitExitFullscreen) {
    d.webkitExitFullscreen();
  } else if ((video as WebKitVideo).webkitDisplayingFullscreen) {
    (video as WebKitVideo).webkitExitFullscreen?.();
  }
}

export function canPictureInPicture(video: HTMLVideoElement): boolean {
  const doc = video.ownerDocument as Document & { pictureInPictureEnabled?: boolean };
  if (doc.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
  return (video as WebKitVideo).webkitSupportsPresentationMode?.("picture-in-picture") === true;
}

export function isPictureInPicture(video: HTMLVideoElement): boolean {
  const doc = video.ownerDocument as Document & { pictureInPictureElement?: Element | null };
  return (
    doc.pictureInPictureElement === video ||
    (video as WebKitVideo).webkitPresentationMode === "picture-in-picture"
  );
}

export async function togglePictureInPicture(video: HTMLVideoElement): Promise<void> {
  const doc = video.ownerDocument as Document & {
    pictureInPictureElement?: Element | null;
    exitPictureInPicture?: () => Promise<void>;
  };
  const webkit = video as WebKitVideo;
  if (isPictureInPicture(video)) {
    if (doc.pictureInPictureElement && doc.exitPictureInPicture) await doc.exitPictureInPicture();
    else webkit.webkitSetPresentationMode?.("inline");
    return;
  }
  const request = (video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
    .requestPictureInPicture;
  if (request) await request.call(video);
  else webkit.webkitSetPresentationMode?.("picture-in-picture");
}
