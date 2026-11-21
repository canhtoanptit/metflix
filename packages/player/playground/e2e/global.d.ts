// The playground host's test hooks (see playground/App.tsx).
interface PgWindowHooks {
  events: { at: number; name: string; detail: unknown }[];
  handle: () => {
    seek(positionSec: number): void;
    play(): Promise<void>;
    pause(): void;
    getCurrentTime(): number;
    getPhase(): string;
    readonly media: HTMLVideoElement | null;
  } | null;
  setBlocked: (value: boolean) => void;
  setMounted: (value: boolean) => void;
  session: () => { id: string; manifestUrl: string } | null;
}

interface Window {
  __pg?: PgWindowHooks;
}
