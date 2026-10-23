/**
 * The arrival bell, rung when a swap completes. Two strikes, as a ship's bell
 * at port. It is synthesized with Web Audio, so nothing has to load before the
 * first swap, and the whole preference is one `localStorage` key.
 *
 * A browser only lets audio start from a user gesture, so `primeSound()` runs
 * on the swap click and the context then stays usable for the completion bell
 * minutes later.
 */

const SOUND_KEY = 'port0-app:sound:v1'

/** True unless the user turned the bell off. Storage failure means on. */
export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

export function setSoundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, enabled ? '1' : '0')
  } catch {
    // Storage unavailable: the preference lasts for this page only.
  }
}

let context: AudioContext | null = null

/** The shared audio context. Null when the browser has no Web Audio. */
function audioContext(): AudioContext | null {
  if (context) return context
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  context = new Ctor()
  return context
}

/** Creates and resumes the audio context. Call from a user gesture. */
export function primeSound(): void {
  const ctx = audioContext()
  if (ctx && ctx.state === 'suspended') void ctx.resume()
}

/**
 * Strikes a bell: a fundamental with inharmonic partials, which is what makes
 * metal sound like metal, over a fast attack and a 1.46 s ring. The upper
 * partials are quiet, because brightness is what makes a strike feel loud.
 */
function strike(ctx: AudioContext, startAt: number, frequency: number): void {
  const partials: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [2.76, 0.25],
    [5.4, 0.06],
  ]
  const envelope = ctx.createGain()
  envelope.gain.setValueAtTime(0.0001, startAt)
  envelope.gain.exponentialRampToValueAtTime(0.125, startAt + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + 1.4625)
  envelope.connect(ctx.destination)
  for (const [ratio, level] of partials) {
    const oscillator = ctx.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency * ratio, startAt)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(level, startAt)
    oscillator.connect(gain)
    gain.connect(envelope)
    oscillator.start(startAt)
    oscillator.stop(startAt + 1.575)
  }
}

/** Rings the two-strike arrival bell, unless the user turned sound off. */
export function playArrivalBell(): void {
  if (!soundEnabled()) return
  const ctx = audioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  // 10% below the 396 Hz trial: 396 x 0.9 = 356.4 Hz. Ring and gap are 75% of
  // the earlier times: the second 25% faster pass.
  const now = ctx.currentTime + 0.02
  strike(ctx, now, 356.4)
  strike(ctx, now + 0.28125, 356.4)
}
