/**
 * The wait spinner: a braille sweep.
 *
 * Eight-dot cells, because the cell a font draws has four rows: a spinner whose
 * frames only set dots 1 to 6 rotates in the top three rows and leaves the
 * fourth empty. These frames sweep every dot, so the rotation fills the cell.
 *
 * This is the app's only spinner. Callers supply the node and the styling; the
 * sweep writes the text and nothing else. The pool page's boot loader runs it.
 * The token picker does not: a glyph in a text field overlaps the placeholder,
 * so that field pulses its border instead.
 */

/** Milliseconds between frames. */
export const SPINNER_INTERVAL_MS = 90

/** The eight frames, in sweep order. */
export const SPINNER_FRAMES: readonly string[] = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

/**
 * Sweeps the frames through `node` and returns a stop function. Calling the
 * stop function twice is harmless; the interval is cleared once.
 */
export function startSpinner(
  node: HTMLElement,
  intervalMs = SPINNER_INTERVAL_MS,
): () => void {
  let frame = 0
  node.textContent = SPINNER_FRAMES[frame]
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length
    node.textContent = SPINNER_FRAMES[frame]
  }, intervalMs)
  return () => clearInterval(timer)
}
