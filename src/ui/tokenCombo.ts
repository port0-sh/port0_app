/**
 * Token autocomplete, shared by every token field in the app.
 *
 * A text input over a hidden select, with a dropdown of matches from a source,
 * keyboard navigation, and selection by click or Enter. The select stays the
 * value every caller reads, so existing form logic is untouched.
 */

import { clear, el } from '../lib/dom'
import { formatAmount, shortAddress } from '../lib/format'

/** One selectable token: what the dropdown shows and the amount math needs. */
export interface TokenEntry {
  symbol: string
  decimals: number
  /** Wallet balance in base units; absent when the caller has none. */
  amount?: bigint
}

/** The dropdown contents, plus the message when there is nothing to show. */
export interface TokenSource {
  entries: Array<[string, TokenEntry]>
  emptyNote?: string
}

export interface TokenComboHandle {
  /** Rewrites the input from the select's current value. */
  refresh: () => void
  /** The list is being read: the field says so in place of its placeholder. */
  setLoading: (loading: boolean) => void
}

/**
 * Mounts the autocomplete. The source is read on every open, so a caller can
 * change the list (wallet tokens, pool tokens) without remounting. `labelOf`
 * names a selected id, and `onChoose` runs after any selection change,
 * including a cleared one.
 */
export function mountTokenCombo(
  input: HTMLInputElement,
  select: HTMLSelectElement,
  source: () => TokenSource,
  labelOf: (id: string) => string,
  onChoose?: () => void,
): TokenComboHandle {
  const list = el('div', { class: 'token-combo-list', hidden: true })
  const icon = el('span', { class: 'token-combo-icon', 'aria-hidden': 'true' }, '▾')
  input.parentElement?.append(list, icon)
  let matches: Array<[string, TokenEntry]> = []
  let emptyNote: string | undefined
  let active = -1
  /** True while the input holds text the user typed, not the selected label. */
  let typed = false

  const refresh = (): void => {
    input.value = select.value ? labelOf(select.value) : ''
    typed = false
  }

  // Plain text, no glyph and no animation: the wallet read can occupy the main
  // thread, which chops any animation and makes a spinner look stuck.
  const idlePlaceholder = input.placeholder
  const setLoading = (loading: boolean): void => {
    input.placeholder = loading ? 'Loading tokens…' : idlePlaceholder
  }

  const close = (): void => {
    list.hidden = true
    if (input.value.trim() === '') {
      // Deleted: the selection goes with it.
      if (select.value !== '') {
        select.value = ''
        onChoose?.()
      }
      input.value = ''
      typed = false
    } else {
      refresh()
    }
  }

  const choose = (id: string): void => {
    select.value = id
    refresh()
    list.hidden = true
    onChoose?.()
  }

  /** The filter text: a selected label is not a query, a typed value is. */
  const queryText = (): string => (typed ? input.value : '')

  const renderList = (): void => {
    clear(list)
    if (matches.length === 0) {
      list.append(el('p', { class: 'muted token-combo-empty' }, emptyNote ?? 'No token matches.'))
      return
    }
    matches.forEach(([id, meta], index) => {
      const option = el(
        'button',
        { type: 'button', class: `token-combo-option${index === active ? ' active' : ''}` },
        el(
          'span',
          { class: 'token-combo-name' },
          el('span', { class: 'token-combo-symbol' }, meta.symbol),
          // The id, not a hex fragment: a bech32 id keeps its own characters
          // before the routing suffix, which is what tells two tokens apart.
          el('span', { class: 'token-combo-id mono' }, shortAddress(id)),
        ),
        meta.amount === undefined
          ? null
          : el('span', { class: 'token-combo-amount' }, formatAmount(meta.amount, meta.decimals)),
      )
      // mousedown, not click: the input's blur fires before click.
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        choose(id)
      })
      list.append(option)
    })
  }

  const open = (): void => {
    const query = queryText().trim().toLowerCase().replace(/^0x/, '')
    const from = source()
    emptyNote = from.emptyNote
    matches = from.entries.filter(
      ([id, meta]) => !query || meta.symbol.toLowerCase().includes(query) || id.includes(query),
    )
    active = matches.findIndex(([id]) => id === select.value)
    renderList()
    list.hidden = false
  }

  input.addEventListener('focus', () => {
    // Select the current symbol so typing replaces it with the search text.
    input.select()
    open()
  })
  input.addEventListener('input', () => {
    typed = true
    open()
  })
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!list.hidden) close()
    }, 120)
  })
  input.addEventListener('keydown', (event) => {
    if (list.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      open()
      event.preventDefault()
      return
    }
    if (event.key === 'ArrowDown') {
      if (matches.length > 0) active = Math.min(active + 1, matches.length - 1)
      renderList()
      event.preventDefault()
    } else if (event.key === 'ArrowUp') {
      if (matches.length > 0) active = Math.max(active - 1, 0)
      renderList()
      event.preventDefault()
    } else if (event.key === 'Enter') {
      // Only an explicitly highlighted option is chosen.
      if (active >= 0 && matches[active]) {
        choose(matches[active][0])
        event.preventDefault()
      }
    } else if (event.key === 'Escape') {
      close()
    }
  })

  refresh()
  return { refresh, setLoading }
}
