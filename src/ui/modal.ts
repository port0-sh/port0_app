/**
 * Modal dialogs built on the native <dialog> element.
 */

import { el } from '../lib/dom'

export interface ModalHandle {
  close: () => void
}

export function openModal(
  title: string,
  body: Node,
  actions: Node | null = null,
  onClose?: () => void,
): ModalHandle {
  const dialog = el('dialog', { class: 'modal' })
  const closeButton = el(
    'button',
    { class: 'btn', type: 'button', onclick: () => close() },
    'Close',
  )
  dialog.append(el('h2', {}, title), body)
  dialog.append(
    actions
      ? el('div', { class: 'form-actions' }, actions, closeButton)
      : el('div', { class: 'form-actions' }, closeButton),
  )
  document.body.append(dialog)

  function close(): void {
    if (dialog.open) dialog.close()
    dialog.remove()
    onClose?.()
  }

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })

  dialog.showModal()
  return { close }
}
