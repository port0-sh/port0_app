/**
 * Token picker for the pool parameters: a select populated from the
 * connected wallet's assets, with a manual text input behind a toggle.
 *
 * The text input is always the source of truth (the select writes into it);
 * this keeps the read path unchanged.
 */

import { getPublicAccount, sdkModule } from '../lib/client'
import { formatAmount } from '../lib/format'
import { requestAssets, walletStore } from '../wallet/wallet'

export interface TokenPicker {
  /** Sets the picked value and switches to the visible input. */
  setValue: (hex: string) => void
}

export function mountTokenPicker(
  selectId: string,
  inputId: string,
  toggleId: string,
): TokenPicker {
  const select = document.getElementById(selectId) as HTMLSelectElement | null
  const input = document.getElementById(inputId) as HTMLInputElement | null
  const toggle = document.getElementById(toggleId) as HTMLButtonElement | null
  if (!select || !input || !toggle) return { setValue: () => {} }

  let manual = false

  const applyMode = (): void => {
    if (manual) {
      select.hidden = true
      input.hidden = false
      toggle.textContent = 'from wallet'
    } else {
      select.hidden = false
      input.hidden = true
      toggle.textContent = 'manual'
    }
  }

  const setValue = (hex: string): void => {
    input.value = hex
    manual = true
    applyMode()
    input.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  toggle.addEventListener('click', () => {
    manual = !manual
    applyMode()
  })

  select.addEventListener('change', () => {
    if (select.value) input.value = select.value
  })

  const populate = async (): Promise<void> => {
    if (!walletStore.get().connected) {
      manual = true
      applyMode()
      return
    }
    try {
      const assets = await requestAssets()
      const { BasicFungibleFaucetComponent } = await sdkModule()
      const options: { id: string; label: string }[] = []
      for (const asset of assets) {
        try {
          const account = await getPublicAccount(asset.faucetId)
          const meta = BasicFungibleFaucetComponent.fromAccount(account)
          const symbol = meta.symbol().toString()
          // `amount` is base units as a string; fall back to it verbatim if
          // the wallet ever reports a decimal form instead.
          let balance = asset.amount
          try {
            balance = formatAmount(BigInt(asset.amount), meta.decimals())
          } catch {
            // keep the raw string
          }
          options.push({ id: asset.faucetId, label: `${symbol} · ${balance}` })
        } catch {
          // Not a fungible faucet (e.g. an LP token); skip it.
        }
      }
      select.replaceChildren()
      if (options.length === 0) {
        manual = true
      } else {
        select.append(new Option('Select a token…', ''))
        for (const option of options) {
          select.append(new Option(option.label, option.id))
        }
        manual = false
      }
      applyMode()
    } catch {
      manual = true
      applyMode()
    }
  }

  void populate()
  walletStore.subscribe(() => {
    void populate()
  })

  return { setValue }
}
