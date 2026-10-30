import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SEA_PATTERN,
  SHIP_ART,
  SPINNER_FRAMES,
  bedForHull,
  loaderFrame,
  loaderMarkup,
  cellWidth,
  lineWidth,
  startSpinner,
  windowOf,
} from './spinner'

describe('spinner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes a frame immediately and sweeps in order', () => {
    vi.useFakeTimers()
    const node = { textContent: '' } as HTMLElement
    startSpinner(node)
    expect(node.textContent).toBe(SPINNER_FRAMES[0])
    vi.advanceTimersByTime(90)
    expect(node.textContent).toBe(SPINNER_FRAMES[1])
    vi.advanceTimersByTime(90 * (SPINNER_FRAMES.length - 1))
    expect(node.textContent).toBe(SPINNER_FRAMES[0])
  })

  it('stops on demand and stays stopped', () => {
    vi.useFakeTimers()
    const node = { textContent: '' } as HTMLElement
    const stop = startSpinner(node)
    vi.advanceTimersByTime(90)
    const frame = node.textContent
    stop()
    stop()
    vi.advanceTimersByTime(900)
    expect(node.textContent).toBe(frame)
  })

  it('has eight distinct eight-dot frames', () => {
    // Eight dots per cell is what fills the four rows a font draws.
    expect(SPINNER_FRAMES).toHaveLength(8)
    expect(new Set(SPINNER_FRAMES).size).toBe(8)
    for (const frame of SPINNER_FRAMES) {
      expect(frame).toMatch(/^[\u2800-\u28ff]$/)
    }
  })
})

describe('ascii loader', () => {
  it('draws the ship exactly as given', () => {
    const lines = SHIP_ART.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('\u3000\u3001')
    expect(lines[3]).toBe('\uff91.\u4e8c\u4e8c\u30ce')
  })

  it('counts full-width glyphs as two cells', () => {
    expect(cellWidth('A')).toBe(1)
    expect(cellWidth('ﾑ')).toBe(1)
    expect(cellWidth('～')).toBe(2)
    expect(cellWidth('　')).toBe(2)
    expect(cellWidth('二')).toBe(2)
    expect(lineWidth('ﾑ.二二ノ')).toBe(8)
  })

  it('keeps every water glyph the same width', () => {
    // This is what fixes the hull's column: a run of water characters is a
    // constant number of cells whatever it contains. A mixed-width stretch has no
    // constant prefix width, and the rig cannot line up with the hull.
    const chars = [...SEA_PATTERN]
    expect(chars.length).toBeGreaterThan(10)
    for (const char of chars) expect(cellWidth(char)).toBe(2)
  })

  it('leaves one clear character either side of the hull', () => {
    const water = '～'.repeat(40)
    const hull = 'ﾑ.二二ノ'
    const bed = bedForHull(water, hull, 10)
    const line = bed.before + bed.hull + bed.after
    expect(line).toContain('\u3000ﾑ.二二ノ\u3000')
    // The gaps are wide blanks and the covered water is dropped, so the line
    // keeps the width the water had.
    expect(lineWidth(line)).toBe(lineWidth(water))
  })

  it('keeps long clear stretches between groups of waves', () => {
    // Every gap between groups is four wide blanks, so the sea reads as groups
    // with pauses rather than one continuous band.
    const gaps = SEA_PATTERN.split(/[^\u3000]+/).filter((gap) => gap.length > 0)
    expect(gaps.length).toBeGreaterThan(3)
    for (const gap of gaps) expect(gap).toHaveLength(4)
  })

  it('takes a window of whole characters, wrapping around the stretch', () => {
    expect(windowOf('abcdef', 2, 3)).toBe('cde')
    expect(windowOf('abcdef', 5, 3)).toBe('fab')
    expect(windowOf('～～～～', 0, 2)).toBe('～～')
  })
})

describe('loaderFrame', () => {
  it('keeps the hull line and the line below as wide as the water window', () => {
    for (const [chars, column] of [
      [21, 2],
      [65, 20],
    ] as const) {
      const frame = loaderFrame(0, chars, column)
      expect(lineWidth(frame.before) + lineWidth(frame.hull) + lineWidth(frame.after)).toBe(
        2 * chars,
      )
      expect(lineWidth(frame.below)).toBe(2 * chars)
    }
  })

  it('pads every upper line to the ship column', () => {
    const frame = loaderFrame(0, 65, 20)
    expect(frame.rig).toHaveLength(SHIP_ART.split('\n').length - 1)
    for (const line of frame.rig) expect(line.startsWith('\u3000'.repeat(20))).toBe(true)
  })

  it('moves the water one character per step at a constant width', () => {
    const first = loaderFrame(0, 20, 2)
    const second = loaderFrame(1, 20, 2)
    expect(second.below).not.toBe(first.below)
    expect(lineWidth(second.below)).toBe(lineWidth(first.below))
    expect(second.before).not.toBe(first.before)
  })
})

describe('loaderMarkup', () => {
  it('carries the frame and the aria text', () => {
    const markup = loaderMarkup('pools')
    expect(markup).toContain('class="loader"')
    expect(markup).toContain('aria-label="Loading pools"')
    expect(markup).toContain('aria-valuetext="Loading pools"')
    expect(markup).toContain('class="loader-water"')
  })

  it('adds the grey description only when one is given', () => {
    expect(loaderMarkup('pools', 'Reading the pools.')).toContain(
      '<p class="muted loader-detail">Reading the pools.</p>',
    )
    expect(loaderMarkup('pools')).not.toContain('loader-detail')
  })
})
