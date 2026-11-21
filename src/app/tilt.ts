/**
 * Pointer parallax for the tilted HUD panels. Writes --sfb-px / --sfb-py (-1..1, 0 at the
 * centre of the window) on each element; the stylesheet turns them into a few degrees of
 * rotation on top of each panel's resting tilt.
 *
 * Does nothing on touch devices or when the user asked for reduced motion.
 */
export function attachTilt(els: HTMLElement[]): void {
  if (typeof window.matchMedia !== 'function') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  let targetX = 0;
  let targetY = 0;
  let x = 0;
  let y = 0;
  let frame = 0;

  const step = (): void => {
    // Ease toward the pointer from wherever the panels are now, so a change of direction
    // mid-way never jumps.
    x += (targetX - x) * 0.12;
    y += (targetY - y) * 0.12;
    const settled = Math.abs(targetX - x) < 0.002 && Math.abs(targetY - y) < 0.002;
    if (settled) {
      x = targetX;
      y = targetY;
    }
    for (const el of els) {
      el.style.setProperty('--sfb-px', x.toFixed(3));
      el.style.setProperty('--sfb-py', y.toFixed(3));
    }
    frame = settled ? 0 : requestAnimationFrame(step);
  };

  window.addEventListener(
    'pointermove',
    (e) => {
      // Hold still while a button is down: the user is dragging the camera or a control.
      if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
      targetX = (e.clientX / window.innerWidth) * 2 - 1;
      targetY = (e.clientY / window.innerHeight) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(step);
    },
    { passive: true },
  );
}
