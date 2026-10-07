/**
 * Tiny DOM construction helpers. Handles the 20% of DOM work pages repeat:
 * creating elements, wiring events, clearing and locating nodes.
 */

export type Child = Node | string | number | null | undefined | false
export type Attrs = Record<string, unknown>

const isEvent = (key: string): boolean => key.startsWith('on') && key.length > 2

/**
 * Creates an element with attributes and children.
 * Attribute conventions: `class`, `style` (object), `dataset` (object),
 * `on*` (event listeners), `value`/`checked`/`disabled` (properties),
 * anything else known as a DOM property, then `setAttribute` as fallback.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (isEvent(key) && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'class') {
      node.className = String(value)
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value)
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value as Record<string, string>)
    } else if (key === 'value' || key === 'checked' || key === 'disabled') {
      ;(node as unknown as Record<string, unknown>)[key] = value
    } else if (key in node) {
      ;(node as unknown as Record<string, unknown>)[key] = value
    } else {
      node.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    )
  }
  return node
}

/** Queries a single element, throwing when missing. Fails loudly, not silently. */
export function qs<T extends Element = HTMLElement>(
  root: ParentNode,
  selector: string,
): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`missing element: ${selector}`)
  return found
}

/** Removes all children of a node. */
export function clear(node: Node): void {
  while (node.firstChild) node.firstChild.remove()
}

/** Sets text content when the element exists; no-op otherwise. */
export function setText(element: Element | null, value: string): void {
  if (element) element.textContent = value
}
