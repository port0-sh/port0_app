/**
 * The app's waiting UI.
 *
 * `startSpinner` sweeps eight-dot braille frames through a fixed-width slot. The
 * loader draws a ship on scrolling water as one text block; its frames are part
 * of the document and an inline script starts the animation at parse time (see
 * the `port0-inline-loader` plugin), so a panel is never empty and never still
 * while the bundle loads. The module only adopts the stop.
 */

/** Milliseconds between spinner frames. */
export const SPINNER_INTERVAL_MS = 90

/** The eight frames, in sweep order. */
export const SPINNER_FRAMES: readonly string[] = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

/**
 * Sweeps the frames through `node` and returns a stop function. Calling the stop
 * function twice is harmless; the interval is cleared once.
 */
export function startSpinner(node: HTMLElement, intervalMs = SPINNER_INTERVAL_MS): () => void {
  let frame = 0
  node.textContent = SPINNER_FRAMES[frame]
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length
    node.textContent = SPINNER_FRAMES[frame]
  }, intervalMs)
  return () => clearInterval(timer)
}

/** The ship, exactly as drawn. */
export const SHIP_ART = ['　、', '　 lヽi', ' _,ﾉ__|＼_,', 'ﾑ.二二ノ'].join('\n')

/** The sea, one repeating stretch of water: crests, gaps, and a pair of quotes. */
export const SEA_PATTERN =
  '～～　　　　＂＂　　　　～～～～　　　　～～～～～　　　　～　　　　～～～'

/** Stretches written before a window is taken. Enough to overflow any panel. */
export const SEA_STRETCHES = 16

/** Milliseconds between one-character steps of the water. */
export const SEA_INTERVAL_MS = 140

/** Water characters in every frame: past any panel, clipped by the loader's box. */
const FRAME_CHARS = 160

/**
 * The ship's column in the served frame, in wide characters. The document script
 * recomposes it for the panel before the first paint, so this value only reaches
 * a reader who never runs the script.
 */
const STATIC_COLUMN = 16

/** The display cells a character occupies: full-width glyphs take two. */
export function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  return wide ? 2 : 1
}

/** The width of a line in display cells. */
export function lineWidth(text: string): number {
  let total = 0
  for (const char of text) total += cellWidth(char)
  return total
}

/** `count` characters of `text` from `offset`, wrapping around the stretch. */
export function windowOf(text: string, offset: number, count: number): string {
  const chars = [...text]
  if (chars.length === 0) return ''
  const out: string[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(chars[(offset + index) % chars.length]!)
  }
  return out.join('')
}

/**
 * The water line split around the hull, in the three runs the printer draws.
 *
 * The gaps and the characters the hull covers are dropped, so no water prints
 * under the boat and the line keeps its width. The runs are separate because the
 * water and the hull print in different colours.
 */
export function bedForHull(
  water: string,
  hull: string,
  column: number,
): { before: string; hull: string; after: string } {
  const covered = Math.ceil(lineWidth(hull) / 2)
  return {
    before: `${water.slice(0, column)}\u3000`,
    hull,
    after: `\u3000${water.slice(column + covered + 2)}`,
  }
}

/** One frame of the loader: the padded upper lines, then the hull line in runs. */
export interface LoaderFrame {
  rig: string[]
  before: string
  hull: string
  after: string
  below: string
}

/**
 * The frame at `offset`, for a water line of `chars` wide characters and the
 * ship at `column`.
 *
 * The width of every run is exact in cells, so the hull's column and the water's
 * prefix agree by construction. Nothing but the water moves.
 */
export function loaderFrame(offset: number, chars: number, column: number): LoaderFrame {
  const tiled = SEA_PATTERN.repeat(SEA_STRETCHES)
  const lines = SHIP_ART.split('\n')
  const hull = lines.pop() ?? ''
  const padding = '\u3000'.repeat(column)
  const bed = bedForHull(windowOf(tiled, offset, chars), hull, column)
  return {
    rig: lines.map((line) => `${padding}${line}`),
    before: bed.before,
    hull: bed.hull,
    after: bed.after,
    below: windowOf(tiled, offset + 9, chars),
  }
}

/**
 * The loader's markup for one host: the frame and, when named, the grey line that
 * says what the read waits for.
 *
 * The frame is composed at build time because a document cannot measure itself.
 * Every frame carries `FRAME_CHARS` of water and the loader's box clips the
 * overflow.
 */
export function loaderMarkup(state: string, detail?: string): string {
  const drawn = loaderFrame(0, FRAME_CHARS, STATIC_COLUMN)
  const water = (text: string): string => `<span class="loader-water">${text}</span>`
  const frame = [
    drawn.rig.join('\n'),
    `${water(drawn.before)}${drawn.hull}${water(`${drawn.after}\n${drawn.below}`)}`,
  ].join('\n')
  return [
    `<div class="loader" role="progressbar" aria-label="Loading ${state}"`,
    ` aria-valuetext="Loading ${state}">`,
    `<pre class="loader-text" aria-hidden="true">${frame}</pre>`,
    detail === undefined ? '' : `<p class="muted loader-detail">${detail}</p>`,
    '</div>',
  ].join('')
}

/** A host whose loader has been started; the stop travels on the element. */
interface LoaderHost extends HTMLElement {
  port0StopLoader?: () => void
}

/**
 * Starts the loader in `host` and returns its stop.
 *
 * The hull is centred on the panel: one wide glyph is measured from the rendered
 * frame, the panel is counted in cells, and the column follows from that. The
 * rig is rewritten once; each step rewrites only the two water runs, so the ship
 * stays where it is. A reduced-motion reader gets the frame at rest and no timer.
 */
function startLoader(host: LoaderHost): () => void {
  const loader = host.querySelector<HTMLElement>('.loader')
  const pre = loader?.querySelector('pre')
  const water = pre === null || pre === undefined ? [] : [...pre.querySelectorAll('.loader-water')]
  const rig = pre?.firstChild
  if (
    loader === null ||
    loader === undefined ||
    pre === null ||
    pre === undefined ||
    water.length !== 2 ||
    !(rig instanceof Text)
  ) {
    throw new Error('loader: the host carries no static frame')
  }

  // A wide glyph decides how many cells the panel holds. Measured, never shown.
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  probe.textContent = '\u3000'.repeat(50)
  loader.append(probe)
  const advance = probe.getBoundingClientRect().width / 50
  probe.remove()

  const panelCells = advance > 0 ? Math.floor(loader.clientWidth / (advance / 2)) : 160
  // The hull starts at cells 2 * column + 2 and is 8 cells wide, so this puts its
  // centre on the panel's centre.
  const column = Math.max(0, Math.floor(panelCells / 4) - 3)

  const draw = (offset: number): void => {
    const drawn = loaderFrame(offset, FRAME_CHARS, column)
    water[0].textContent = drawn.before
    water[1].textContent = `${drawn.after}\n${drawn.below}`
  }
  const first = loaderFrame(0, FRAME_CHARS, column)
  rig.textContent = `${first.rig.join('\n')}\n`
  water[0].textContent = first.before
  water[1].textContent = `${first.after}\n${first.below}`

  const remove = (): void => loader.remove()
  const stop = (): void => {
    window.clearInterval(timer)
    remove()
  }

  let timer = 0
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    host.port0StopLoader = remove
    return remove
  }
  let offset = 0
  timer = window.setInterval(() => {
    offset = (offset + 1) % [...SEA_PATTERN].length
    draw(offset)
  }, SEA_INTERVAL_MS)
  host.port0StopLoader = stop
  return stop
}
/** Starts every loader host in the document; called by the inline bootstrap. */
export function startDocumentLoaders(): void {
  for (const host of document.querySelectorAll<LoaderHost>('[data-loader-state]')) {
    startLoader(host)
  }
}

/**
 * The stop for the loader the document started, or null when the host carries
 * none. The animation belongs to the document, so the module only ends it.
 */
export function adoptLoader(host: HTMLElement): (() => void) | null {
  return (host as LoaderHost).port0StopLoader ?? null
}
