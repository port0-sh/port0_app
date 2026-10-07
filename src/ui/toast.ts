/**
 * Toast notifications. A fixed-position stack in #toast-root; each toast
 * removes itself after a fixed lifetime.
 */

import { el } from '../lib/dom'

export type ToastKind = 'info' | 'error'

const DEFAULT_TTL_MS = 6000

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
    message,
  )
  root.append(node)
  setTimeout(() => node.remove(), ttlMs)
  return node
}
