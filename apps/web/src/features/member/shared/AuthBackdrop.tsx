import { PosterWall } from "./PosterWall.tsx";

/**
 * Behind the sign-in and sign-up forms: a dimmed wall of catalog posters on wide screens (the
 * product is the pitch), the warm ambient glow alone on phones where the form fills the screen.
 */
export function AuthBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 hidden opacity-45 md:block">
        <PosterWall rows={4} />
      </div>
      <div className="absolute inset-0 hidden bg-canvas/40 md:block" />
      <div className="absolute inset-0 hidden scrim-top md:block" />
      <div className="absolute inset-0 hidden scrim-bottom md:block" />
      <div className="absolute inset-0 bg-glow" />
    </div>
  );
}
