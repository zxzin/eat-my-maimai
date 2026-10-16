// Keep the drawing buffer aligned with the display after zoom, monitor changes,
// and responsive previews. Small screens retain the existing rendering budget.
export function syncRendererResolution(renderer, { width, height, dpr }) {
  const pixelRatio = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, width < 700 ? 1.5 : 2);
  if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height);
  return { width, height, pixelRatio, bufferWidth: Math.floor(width * pixelRatio), bufferHeight: Math.floor(height * pixelRatio) };
}

// Chromium responsive previews can change DPR without firing resize or media
// query events. Compare this scalar on each frame; resize only when it changes.
// The browser suspends animation frames while the page is hidden.
export function watchDisplayDensity(callback, display = globalThis) {
  let density = display.devicePixelRatio || 1, frame, active = true;
  const check = () => {
    if (!active) return;
    const next = display.devicePixelRatio || 1;
    if (next !== density) {
      density = next;
      callback();
    }
    if (active) frame = display.requestAnimationFrame(check);
  };
  frame = display.requestAnimationFrame(check);
  return () => {
    active = false;
    display.cancelAnimationFrame(frame);
  };
}
