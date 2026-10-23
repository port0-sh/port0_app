import { afterEach, describe, expect, it, vi } from 'vitest'

import { SPINNER_FRAMES, startSpinner } from './spinner'

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
