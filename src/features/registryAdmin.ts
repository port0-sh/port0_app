/**
 * Registry admin: changes what registering a pool costs.
 *
 * The registry accepts a fee change only from the admin account it was created
 * with, and only for the register note's own price. This panel reads both the
 * admin and the live fee from chain, refuses to submit when the connected wallet
 * is not the admin, and otherwise emits a registry-config note with the
 * sponsorship that pays its fee, then waits for the price on chain to change.
 */

import { CONFIG } from '../lib/config'
import { el, setText } from '../lib/dom'
import { formatAmount, shortHex } from '../lib/format'
import { getClient, getPublicAccount, sdkModule, xykModule } from '../lib/client'
import { openModal } from '../ui/modal'
import { toast } from '../ui/toast'
import { submitViaWallet, walletAccountId } from '../wallet/wallet'

/**
 * The fee in human form: base units plus the amount in the fee asset's own units.
 *
 * The registry charges in the chain fee asset, whose metadata comes from its
 * faucet account. A failed read falls back to base units rather than hiding the
 * number.
 */
async function formatFee(baseUnits: bigint): Promise<string> {
  try {
    const { BasicFungibleFaucetComponent } = await sdkModule()
    const faucet = await getPublicAccount(CONFIG.chainFeeFaucetId)
    const meta = BasicFungibleFaucetComponent.fromAccount(faucet)
    const decimals = meta.decimals()
    const symbol = meta.symbol().toString()
    return `${baseUnits} base units (${formatAmount(baseUnits, decimals)} ${symbol})`
  } catch {
    return `${baseUnits} base units`
  }
}

/** Poll interval while waiting for the registry to consume the config note. */
const POLL_MS = 5_000
/** How long to wait for the price to change before reporting. */
const WAIT_MS = 180_000

export function openRegistryAdmin(): void {
  const registry = el('input', {
    type: 'text',
    value: CONFIG.registryId,
    spellcheck: false,
    required: true,
  })
  const fee = el('input', {
    type: 'text',
    inputmode: 'numeric',
    placeholder: 'base units, e.g. 119',
    spellcheck: false,
    required: true,
  })
  const current = el('span', { class: 'muted' })
  const adminLine = el('span', { class: 'mono' })
  const status = el('span', { class: 'muted' })
  /** Status text, in the error colour when it reports a refusal. */
  const setStatus = (message: string, isError = false): void => {
    status.className = isError ? 'error' : 'muted'
    setText(status, message)
  }
  /** Writes a plain value next to a field, always in the muted style. */
  const setValue = (node: HTMLElement, message: string): void => {
    node.className = 'muted'
    setText(node, message)
  }
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Change fee')

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('label', {}, 'Registry'),
    registry,
    el('label', {}, 'Admin'),
    adminLine,
    el('label', {}, 'Current fee'),
    current,
    el('label', {}, 'New fee'),
    fee,
    el(
      'span',
      { class: 'muted hint' },
      'Base units of the fee asset. Only the register note is repriced; the admin cannot touch funds or pool parameters.',
    ),
    el('div', { class: 'form-actions' }, submit, status),
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void change()
  })

  openModal('Registry admin', form)
  void load()

  /** Reads the registry's admin and fee, and disables the form when the wallet cannot act. */
  async function load(): Promise<void> {
    setStatus( '')
    try {
      const wallet = await walletAccountId()
      if (!wallet) throw new Error('Connect a wallet first.')
      const [client, sdk, { AccountId }] = await Promise.all([
        getClient(),
        xykModule(),
        sdkModule(),
      ])
      const id = AccountId.fromHex(registry.value.trim())
      // The registry is public and usually not tracked here yet; reading it
      // imports it into the store, which is what `get` alone cannot do.
      const getAccount = async (accountId: typeof id) => {
        try {
          return await client.accounts.getOrImport(accountId)
        } catch {
          return null
        }
      }
      const admin = await sdk.readRegistryAdmin(getAccount, id)
      const live = await sdk.readRegistryRegisterFee(getAccount, id)
      setText(adminLine, shortHex(admin.toString()))
      adminLine.setAttribute('title', admin.toString())
      setValue(current, await formatFee(live))
      fee.value = String(live)
      const isAdmin = admin.toString().toLowerCase() === wallet.toString().toLowerCase()
      submit.disabled = !isAdmin
      if (!isAdmin) {
        setStatus(
          'This wallet is not the registry admin, so it cannot change the fee.',
          true,
        )
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true)
      submit.disabled = true
    }
  }

  async function change(): Promise<void> {
    submit.disabled = true
    setStatus( 'Building the config note…')
    try {
      const wallet = await walletAccountId()
      if (!wallet) throw new Error('Connect a wallet first.')
      const next = BigInt(fee.value.trim())
      if (next <= 0n) throw new Error('The fee must be a positive number of base units.')
      const sdk = await xykModule()
      const { AccountId } = await sdkModule()
      const client = await getClient()
      const id = AccountId.fromHex(registry.value.trim())
      const note = sdk.buildRegistryConfigNote({
        sender: wallet,
        registryId: id,
        registerFee: next,
      })
      // The config note is priced at zero, so the registry pays its own
      // transaction fee; the sponsorship below covers the wallet's emit.
      const sponsor = sdk.buildFeeSponsorshipNote({
        sender: wallet,
        target: id,
        featureNote: note,
        feeFaucetId: AccountId.fromHex(CONFIG.chainFeeFaucetId),
        feeAmount: sdk.NOTE_FEES['registry-config'] > 0n ? sdk.NOTE_FEES['registry-config'] : 210n,
      })
      const request = await sdk.outputNotesRequest(client, [note, sponsor], id)
      setStatus( 'Confirm the transaction in your wallet…')
      const txId = await submitViaWallet(request)
      setStatus( `Submitted ${shortHex(txId)}; waiting for the registry…`)

      const deadline = Date.now() + WAIT_MS
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS))
        await client.syncChain()
        const live = await sdk.readRegistryRegisterFee(
          (accountId) => client.accounts.get(accountId),
          id,
        )
        if (live === next) {
          const human = await formatFee(live)
          setValue(current, human)
          setStatus(`The register fee is now ${human}.`)
          toast('Register fee updated.')
          break
        }
        if (Date.now() > deadline) {
          setStatus(
            `The registry has not consumed the note yet; the fee is still ${live} base units.`,
          )
          break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(message, true)
      toast(message, 'error')
    } finally {
      submit.disabled = false
    }
  }
}
