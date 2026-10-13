/**
 * Token picker for the pool parameters: a select filled from the connected
 * wallet's assets.
 *
 * There is no typed alternative. A pool the creator cannot fund from their own
 * wallet is not a pool they can deploy, so the select is the only input, and it
 * says why it is empty instead of offering a text field.
 */

import { getClient, getPublicAccount, sdkModule } from '../lib/client'
import { formatAmount, shortAddress } from '../lib/format'
import { requestAssets, walletStore } from '../wallet/wallet'

export interface TokenPicker {
  /** Selects a faucet id, adding it to the list when the wallet does not hold it. */
  setValue: (hex: string) => void
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

export function mountTokenPicker(selectId: string): TokenPicker {
  const select = document.getElementById(selectId) as HTMLSelectElement | null
  if (!select) return { setValue: () => {} }

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
      fill([])
      return
    }

    let assets
    try {
      assets = await requestAssets()
    } catch (error) {
      // The wallet refused or failed the read. The list says it is empty; the
      // reason goes to the console, because a toast per wallet state change
      // would repeat the same line several times over one page load.
      console.warn('requestAssets failed:', error)
      fill([])
      return
    }

    const { BasicFungibleFaucetComponent } = await sdkModule()
    const options: { id: string; label: string }[] = []
    let skipped = 0
    for (const asset of assets) {
      // Failures are not cached: a locked or unsynced wallet can answer on the
      // next populate, and only successes are worth remembering.
      let meta = faucetMeta.get(asset.faucetId)
      if (!meta) {
        meta = await readFaucetMeta(asset.faucetId, BasicFungibleFaucetComponent)
        if (meta) faucetMeta.set(asset.faucetId, meta)
      }

      if (!meta) {
        // Not a plain fungible faucet. An LP token is issued by the pool account
        // itself, its metadata does not read as one, and no pool can be created
        // from it, so it is left out rather than listed as unknown.
        skipped += 1
        continue
      }

      let balance = asset.amount
      try {
        balance = formatAmount(BigInt(asset.amount), meta.decimals)
      } catch {
        // The wallet reported something that is not a whole amount.
      }
      options.push({
        id: asset.faucetId,
        label: `${meta.symbol} (${shortAddress(asset.faucetId)}) · ${balance}`,
      })
    }
    if (options.length === 0 && skipped > 0) {
      // Every asset was skipped. Usually that means the wallet holds nothing but
      // LP tokens, but it is also what a failed faucet read looks like, so it is
      // worth one line rather than silence.
      console.warn(`no poolable token among ${skipped} wallet asset(s)`)
    }
    fill(options)
  }

  void populate()
  walletStore.subscribe(() => {
    void populate()
  })

  const setValue = (hex: string): void => {
    if (!hex) return
    if (![...select.options].some((option) => option.value === hex)) {
      select.append(new Option(shortAddress(hex), hex))
    }
    select.value = hex
  }

  return { setValue }
}
