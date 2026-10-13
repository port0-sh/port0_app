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

  // A click outside the dialog's box closes it.
  //
  // The backdrop belongs to the dialog element itself, so checking the event
  // target is not enough: a click on the dialog's own padding would close it and
  // a click on the backdrop would not. The coordinates are compared against the
  // box instead, which treats padding and backdrop alike.
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect()
    const outside =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    if (outside) close()
  })

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    close()
  })

  dialog.showModal()
  return { close }
}
