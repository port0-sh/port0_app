import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { playArrivalBell, primeSound, setSoundEnabled, soundEnabled } from './sound'

const store = new Map<string, string>()
const storage = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => void store.set(key, value),
  removeItem: (key: string): void => void store.delete(key),
}

describe('sound', () => {
  beforeEach(() => {
    store.clear()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is on by default', () => {
    expect(soundEnabled()).toBe(true)
  })

  it('remembers the off choice and the on choice', () => {
    setSoundEnabled(false)
    expect(soundEnabled()).toBe(false)
    setSoundEnabled(true)
    expect(soundEnabled()).toBe(true)
  })

  it('treats a storage failure as on', () => {
    vi.stubGlobal('localStorage', {
      getItem: (): never => {
        throw new Error('denied')
      },
    })
    expect(soundEnabled()).toBe(true)
    expect(() => setSoundEnabled(false)).not.toThrow()
  })

  it('plays nothing where there is no audio element', () => {
    // Node has no `Audio`, so the bell is a no-op rather than a throw.
    vi.stubGlobal('Audio', undefined)
    expect(() => playArrivalBell()).not.toThrow()
    expect(() => primeSound()).not.toThrow()
  })
})
