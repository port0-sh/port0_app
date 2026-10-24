/**
 * Token picker for the pool parameters: a select filled from the connected
 * wallet's assets.
 *
 * There is no typed alternative. A pool the creator cannot fund from their own
 * wallet is not a pool they can deploy, so the select is the only input, and it
 * says why it is empty instead of offering a text field. A pool account is its
 * own LP faucet and carries the standard faucet component, so an LP token the
 * wallet holds is offered like any other token.
 */

import { getClient, getPublicAccount, sdkModule } from '../lib/client'
import { formatAmount, isHexId, normalizeHex, shortAddress, withHexPrefix } from '../lib/format'
import { mountTokenCombo, type TokenEntry } from '../ui/tokenCombo'
import { requestAssets, walletStore } from '../wallet/wallet'

/**
 * A faucet id in one form: `0x` and lower-case for hex, the given form
 * otherwise. The wallet may report either notation for the same faucet.
 */
function toHexId(
  raw: string,
  AccountId: { fromBech32: (value: string) => { toString: () => string } },
): string {
  const value = raw.trim()
  if (isHexId(value)) return withHexPrefix(normalizeHex(value))
  try {
    return AccountId.fromBech32(value).toString()
  } catch {
    return value
  }
}

export interface TokenPicker {
  /** Selects a faucet id, adding it to the list when the wallet does not hold it. */
  setValue: (hex: string) => void
  /** Repopulates the list; used when the pool set arrives after mount. */
  refresh: () => void
}

/** The one option shown when the wallet holds nothing this app can use. */
const EMPTY_LABEL = 'No tokens found in this wallet'
/** The one option shown before a wallet is connected. */
const LOGIN_LABEL = 'Login to load your tokens'

/**
 * Faucet metadata, cached by faucet id.
 *
 * `populate` runs on every wallet state change, so without a cache the same
 * faucets would be read from the node several times per page load.
 */
const faucetMeta = new Map<string, { symbol: string; decimals: number }>()

/** Faucets whose metadata read failed, so the reason is logged once, not per populate. */
const warned = new Set<string>()

/**
 * Faucets the node answered as not basic fungible faucets. Permanent, so the
 * read and its chain sync never repeat.
 */
const notFungible = new Set<string>()

/** The SDK's fungible-faucet reader, as the module exports it. */
type FaucetComponent = Awaited<ReturnType<typeof sdkModule>>['BasicFungibleFaucetComponent']

/**
 * Reads a faucet's symbol and decimals, retrying once after a chain sync.
 *
 * The first attempt is a plain store-or-node read. It fails when the client has
 * not synced since the faucet appeared, which a sync then fixes; that costs one
 * sync for the page, and only when a read actually fails.
 */
async function readFaucetMeta(
  faucetId: string,
  BasicFungibleFaucetComponent: FaucetComponent,
): Promise<{ symbol: string; decimals: number } | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const account = await getPublicAccount(faucetId)
      const meta = BasicFungibleFaucetComponent.fromAccount(account)
      return { symbol: meta.symbol().toString(), decimals: meta.decimals() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Not a basic fungible faucet, which is permanent, and a faucet in that
      // shape cannot be a pool token. It is marked unusable once instead of
      // read, synced, and warned about on every wallet state change.
      if (/basic fungible faucet component/.test(message)) {
        if (!notFungible.has(faucetId)) {
          notFungible.add(faucetId)
          console.info(`not a basic fungible faucet, skipped: ${faucetId}`)
        }
        return undefined
      }
      if (attempt === 1 && !warned.has(faucetId)) {
        warned.add(faucetId)
        console.warn(`faucet metadata unavailable for ${faucetId}:`, error)
        return undefined
      }
      try {
        await (await getClient()).syncChain()
      } catch (syncError) {
        if (!warned.has(faucetId)) {
          warned.add(faucetId)
          console.warn(`chain sync failed while reading ${faucetId}:`, syncError)
        }
        return undefined
      }
    }
  }
  return undefined
}

export interface TokenPickerOptions {
  /**
   * The id the list must not offer: the token the sibling field holds. The
   * select's disabled option is not enough, because the dropdown is built from
   * the entry list and would still offer it.
   */
  exclude?: () => string | null
}

export function mountTokenPicker(
  selectId: string,
  options: TokenPickerOptions = {},
): TokenPicker {
  const select = document.getElementById(selectId) as HTMLSelectElement | null
  if (!select) return { setValue: () => {}, refresh: () => {} }

  // A text input over the select, so this picker behaves like every other token
  // field in the app. The select stays the value every caller reads.
  let entryList: Array<[string, TokenEntry]> = []
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'token-combo-input'
  input.placeholder = 'Select token'
  input.autocomplete = 'off'
  input.spellcheck = false
  select.parentElement?.insertBefore(input, select)
  select.classList.add('swap-hidden-select')
  const combo = mountTokenCombo(
    input,
    select,
    () => {
      // Read on every open, so a token chosen in the sibling field disappears
      // from this list without a repopulate.
      const excluded = options.exclude?.() ?? null
      return {
        entries: excluded ? entryList.filter(([id]) => id !== excluded) : entryList,
        emptyNote: walletStore.get().connected ? EMPTY_LABEL : LOGIN_LABEL,
      }
    },
    (id) => {
      const known = entryList.find(([entryId]) => entryId === id)?.[1].symbol
      if (known) return known
      // Before the list loads, an id has no name; a raw fragment in the field
      // reads as if a token had been chosen. Show the address only once the
      // list is known not to contain it.
      return entryList.length === 0 ? '' : shortAddress(id)
    },
    () => select.dispatchEvent(new Event('change', { bubbles: true })),
  )

  /**
   * Replaces the options, keeping the current choice.
   *
   * `populate` runs on every wallet state change, and the select is the value
   * every other part of the flow reads, so a repopulated list must not discard
   * what the creator already picked.
   */
  const fill = (options: { id: string; label: string }[]): void => {
    const chosen = select.value
    select.replaceChildren()

    if (options.length === 0) {
      const placeholder = new Option(
        walletStore.get().connected ? EMPTY_LABEL : LOGIN_LABEL,
        '',
      )
      placeholder.disabled = true
      placeholder.selected = true
      select.append(placeholder)
      return
    }

    select.append(new Option('Select a token…', ''))
    for (const option of options) {
      select.append(new Option(option.label, option.id))
    }
    if (chosen && options.some((option) => option.id === chosen)) {
      select.value = chosen
    }
  }

  const populate = async (): Promise<void> => {
    if (!walletStore.get().connected) {
      entryList = []
      fill([])
      return
    }

    // Reading the wallet and then each faucet's metadata from the node is not
    // instant; the field's border pulses until the list is written.
    combo.setLoading(true)
    try {
      let assets
      try {
        assets = await requestAssets()
      } catch (error) {
        // The wallet refused or failed the read. The list says it is empty; the
        // reason goes to the console, because a toast per wallet state change
        // would repeat the same line several times over one page load.
        console.warn('requestAssets failed:', error)
        entryList = []
        fill([])
        return
      }

      const { AccountId, BasicFungibleFaucetComponent } = await sdkModule()
      const listed: { id: string; label: string }[] = []
      const comboEntries: Array<[string, TokenEntry]> = []
      let skipped = 0
      for (const asset of assets) {
        // One form per faucet: the adapter may report hex or bech32, and the
        // select, the entry list, and a restored draft must agree on the key.
        const id = toHexId(asset.faucetId, AccountId).trim()
        // Failed reads are not cached: a locked or unsynced wallet can answer on
        // the next populate, and only successes are worth remembering. A faucet
        // that is not basic fungible is cached, because that cannot change.
        let meta = faucetMeta.get(id)
        if (!meta && !notFungible.has(id)) {
          meta = await readFaucetMeta(id, BasicFungibleFaucetComponent)
          if (meta) faucetMeta.set(id, meta)
        }

        if (!meta) {
          // Faucet metadata that does not read as basic fungible, or a read that
          // failed. It is left out rather than listed as an unknown token.
          skipped += 1
          continue
        }

        let rawAmount = 0n
        let balance = asset.amount
        try {
          rawAmount = BigInt(asset.amount)
          balance = formatAmount(rawAmount, meta.decimals)
        } catch {
          // The wallet reported something that is not a whole amount.
        }
        listed.push({
          id,
          label: `${meta.symbol} (${shortAddress(id)}) · ${balance}`,
        })
        comboEntries.push([
          id,
          { symbol: meta.symbol, decimals: meta.decimals, amount: rawAmount },
        ])
      }
      if (listed.length === 0 && skipped > 0) {
        // Every asset was skipped, which is what a failed faucet read looks
        // like; it is worth one line rather than silence.
        console.warn(`no poolable token among ${skipped} wallet asset(s)`)
      }
      entryList = comboEntries
      fill(listed)
    } finally {
      combo.setLoading(false)
    }
  }

  void populate()
  walletStore.subscribe(() => {
    void populate()
  })

  const setValue = (value: string): void => {
    if (!value) return
    // A draft may hold either form. Convert off the render path and let the
    // list populate on its own; the field stays empty until the id has a name.
    void (async () => {
      const { AccountId } = await sdkModule()
      const id = toHexId(value, AccountId)
      const known = [...select.options].some((option) => option.value === id)
      if (!known) select.append(new Option(shortAddress(id), id))
      select.value = id
      combo.refresh()
    })()
  }

  return { setValue, refresh: () => void populate() }
}
