/**
 * Side-car WebVTT tracks. The browser fetches, parses and times the cues (`<track>` elements
 * in `hidden` mode); the player renders the active cues itself so captions share one style
 * everywhere and can move above the controls. In iPhone's system fullscreen, where nothing
 * of ours is visible, the selected track switches to `showing` so the system draws it.
 */
import type { TextTrack as SessionTextTrack } from "@webflix/contracts";
import { parseCueText } from "../core/cue-text.ts";
import type { RenderedCue } from "../core/state.ts";

interface Entry {
  id: string;
  element: HTMLTrackElement;
  onCueChange: () => void;
}

const ALIGNS = new Set(["start", "center", "end", "left", "right"]);

export function toRenderedCue(cue: TextTrackCue, index: number): RenderedCue {
  const vtt = cue as TextTrackCue & {
    text?: string;
    line?: number | "auto";
    snapToLines?: boolean;
    align?: string;
  };
  const align = vtt.align && ALIGNS.has(vtt.align) ? (vtt.align as RenderedCue["align"]) : "center";
  return {
    id: cue.id || `${cue.startTime}-${index}`,
    nodes: parseCueText(vtt.text ?? ""),
    line: typeof vtt.line === "number" ? vtt.line : "auto",
    snapToLines: vtt.snapToLines ?? true,
    align,
  };
}

export class SidecarTextTracks {
  private entries: Entry[] = [];
  /** `<track>`s added where TextTrack is unsupported; removed on clear all the same. */
  private orphans: HTMLTrackElement[] = [];
  private selected: string | null = null;
  private nativeRendering = false;
  private readonly media: HTMLVideoElement;
  private readonly onCues: (cues: RenderedCue[]) => void;

  constructor(media: HTMLVideoElement, onCues: (cues: RenderedCue[]) => void) {
    this.media = media;
    this.onCues = onCues;
  }

  setTracks(tracks: readonly SessionTextTrack[]): void {
    this.clear();
    for (const track of tracks) {
      const element = this.media.ownerDocument.createElement("track");
      element.kind = track.kind;
      element.label = track.label;
      element.srclang = track.language;
      element.src = track.url;
      element.dataset.wfpTrack = track.id;
      this.media.appendChild(element);
      const textTrack = element.track as TextTrack | undefined;
      // Environments without TextTrack support (jsdom, some embedded browsers): no captions.
      if (!textTrack) {
        this.orphans.push(element);
        continue;
      }
      textTrack.mode = "disabled";
      const onCueChange = () => {
        if (this.selected !== track.id) return;
        const cues = textTrack.activeCues;
        const rendered: RenderedCue[] = [];
        if (cues) {
          for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            if (cue) rendered.push(toRenderedCue(cue, i));
          }
        }
        this.onCues(rendered);
      };
      textTrack.addEventListener("cuechange", onCueChange);
      this.entries.push({ id: track.id, element, onCueChange });
    }
    this.applyModes();
  }

  select(id: string | null): void {
    this.selected = id;
    this.applyModes();
    this.onCues([]);
    // Cues already active at the current time: render them without waiting for a change.
    this.entries.find((entry) => entry.id === id)?.onCueChange();
  }

  setNativeRendering(native: boolean): void {
    this.nativeRendering = native;
    this.applyModes();
  }

  destroy(): void {
    this.clear();
    this.selected = null;
  }

  private applyModes(): void {
    for (const entry of this.entries) {
      const mode: TextTrackMode =
        entry.id === this.selected ? (this.nativeRendering ? "showing" : "hidden") : "disabled";
      if (entry.element.track.mode !== mode) entry.element.track.mode = mode;
    }
  }

  private clear(): void {
    for (const entry of this.entries) {
      entry.element.track.removeEventListener("cuechange", entry.onCueChange);
      entry.element.track.mode = "disabled";
      entry.element.remove();
    }
    for (const element of this.orphans) element.remove();
    this.entries = [];
    this.orphans = [];
    this.onCues([]);
  }
}
