/**
 * The arrival bell, rung when a swap completes: the recording in
 * `public/bell.mp3` (5.0 s), played once per completion.
 *
 * The preference is one `localStorage` key. A browser only lets audio start from
 * a user gesture, so `primeSound()` runs on the swap or add-liquidity click and
 * unlocks the element; the completion bell then plays minutes later, after the
 * transaction confirms.
 */

const SOUND_KEY = 'port0-app:sound:v1'
/** Served from `public/`, so the URL is stable and cached. */
const BELL_URL = '/bell.mp3'

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

let element: HTMLAudioElement | null = null

/** The shared audio element, created once. Null where there is no DOM. */
function bell(): HTMLAudioElement | null {
  if (element) return element
  if (typeof Audio === 'undefined') return null
  element = new Audio(BELL_URL)
  element.preload = 'auto'
  return element
}

/**
 * Unlocks playback from a user gesture.
 *
 * Playing muted and pausing runs the gesture path without making a sound, which
 * is what lets the same element play on its own later.
 */
export function primeSound(): void {
  const audio = bell()
  if (!audio) return
  audio.muted = true
  void audio
    .play()
    .then(() => {
      audio.pause()
      audio.currentTime = 0
      audio.muted = false
    })
    .catch(() => {
      audio.muted = false
    })
}

/** Rings the arrival bell, unless the user turned sound off. */
export function playArrivalBell(): void {
  if (!soundEnabled()) return
  const audio = bell()
  if (!audio) return
  // Rewind so a quick second completion rings again instead of being ignored.
  audio.currentTime = 0
  void audio.play().catch(() => {
    // Autoplay refused: the next gesture will allow it.
  })
}
