/**
 * Toast notifications. A fixed-position stack in #toast-root; each toast
 * removes itself after a fixed lifetime.
 */

import { el } from '../lib/dom'

export type ToastKind = 'info' | 'error'

const DEFAULT_TTL_MS = 6000

/**
 * Shows a toast. A positive `ttlMs` removes it after that long; `0` makes it
 * stay until the user closes it, which is what a wallet error needs: the text
 * can be long, and it may be the only record of what the extension said.
 */
export function toast(
  message: string,
  kind: ToastKind = 'info',
  ttlMs = DEFAULT_TTL_MS,
): HTMLElement {
  let root = document.getElementById('toast-root')
  if (!root) {
    root = el('div', { id: 'toast-root', class: 'toast-root' })
    document.body.append(root)
  }
  const node = el(
    'div',
    { class: `toast${kind === 'error' ? ' error' : ''}`, role: 'status' },
    el('span', {}, message),
  )
  if (ttlMs > 0) {
    setTimeout(() => node.remove(), ttlMs)
  } else {
    node.append(
      el(
        'button',
        {
          type: 'button',
          class: 'btn toast-close',
          'aria-label': 'Dismiss',
          onclick: () => node.remove(),
        },
        '×',
      ),
    )
  }
  root.append(node)
  return node
}
