/**
 * Utility: one-time mint.
 *
 * Creates a faucet whose whole supply is minted to the caller's wallet in one
 * transaction, with `maxSupply` equal to that supply, so nothing remains to mint
 * afterwards and no auth component is needed. It is the token-launch step from
 * the pool page, moved here because it is a general utility rather than part of
 * creating a pool.
 *
 * The six steps are forced by the chain: a faucet account must exist before it
 * can be funded, funding arrives as a note, and the note becomes the faucet's
 * first transaction, which is also the one that mints.
 */

import { CONFIG } from '../lib/config'
import { el, setText } from '../lib/dom'
import { shortHex } from '../lib/format'
import {
  DEFAULT_INITIAL_SUPPLY,
  normalizeSymbol,
  parseInitialSupply,
  validateDecimals,
  validateInitialSupply,
  validateSymbol,
} from '../lib/token'
import { openModal } from '../ui/modal'
import { toast } from '../ui/toast'
import { getClient, sdkModule, xykModule } from '../lib/client'
import {
  sendViaWallet,
  waitForTransaction,
  walletAccountId,
} from '../wallet/wallet'

/** Measured per-transaction verification fee, in the chain fee asset. */
const TX_FEE_BASE_UNITS = 133n

/** The faucet's first transaction is paid from a note funded with this. */
const FAUCET_FUNDING_AMOUNT = Number(TX_FEE_BASE_UNITS * 2n)

export function openOneTimeMint(): void {
  const symbol = el('input', {
    type: 'text',
    placeholder: 'MEME',
    minlength: 3,
    maxlength: 6,
    spellcheck: false,
    required: true,
  })
  const decimals = el('input', { type: 'number', min: 0, max: 8, step: 1, value: '4' })
  const supply = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: DEFAULT_INITIAL_SUPPLY,
    spellcheck: false,
    required: true,
  })
  const hint = el('span', { class: 'muted hint' })
  const status = el('span', { class: 'muted' })
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Mint token')
  const result = el('div', { class: 'form-actions', hidden: true })
  const faucetLine = el('span', { class: 'mono' })

  const renderHint = (): void => {
    const raw = supply.value.trim()
    const digits = Number(decimals.value)
    if (!raw || !Number.isInteger(digits) || digits < 0 || digits > 8) {
      setText(hint, '')
      return
    }
    try {
      setText(hint, `= ${parseInitialSupply(raw, digits).toLocaleString('en-US')} base units`)
    } catch {
      setText(hint, '')
    }
  }
  supply.addEventListener('input', renderHint)
  decimals.addEventListener('input', renderHint)
  renderHint()

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('label', {}, 'Symbol'),
    symbol,
    el('span', { class: 'muted hint' }, '3 to 6 uppercase letters, no digits.'),
    el('label', {}, 'Decimals'),
    decimals,
    el('label', {}, 'Supply (tokens)'),
    supply,
    hint,
    el('div', { class: 'form-actions' }, submit, status),
    result,
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void mint()
  })

  openModal('One-time mint', form)

  async function mint(): Promise<void> {
    submit.disabled = true
    setText(status, '')
    try {
      const wallet = await walletAccountId()
      if (!wallet) throw new Error('Connect a wallet first.')

      const symbolError = validateSymbol(symbol.value)
      if (symbolError) throw new Error(symbolError)
      const name = normalizeSymbol(symbol.value)

      const digits = Number(decimals.value)
      const decimalsError = validateDecimals(digits)
      if (decimalsError) throw new Error(decimalsError)

      // Bounded by the AMM contract's MAX_AMOUNT, not an arbitrary cap.
      const { MAX_AMOUNT } = await xykModule()
      const supplyError = validateInitialSupply(supply.value, digits, MAX_AMOUNT)
      if (supplyError) throw new Error(supplyError)
      const total = parseInitialSupply(supply.value, digits)

      const [{ NetworkId, AccountInterface }, client] = await Promise.all([
        sdkModule(),
        getClient(),
      ])

      setText(status, 'Step 1/6: creating the faucet account')
      const faucet = await client.accounts.create({
        type: 'FungibleFaucet',
        storage: 'public',
        name,
        symbol: name,
        decimals: digits,
        maxSupply: total,
      })
      const faucetId = faucet.id().toString()

      // The client runs in a Web Worker with its own WASM instance, so every
      // call below takes the hex string rather than a main-thread handle.
      const faucetAddress = faucet.id().toBech32(NetworkId.testnet(), AccountInterface.BasicWallet)
      setText(status, 'Step 2/6: asking the wallet to fund the faucet')
      const sendTxId = await sendViaWallet(faucetAddress, CONFIG.chainFeeFaucetId, FAUCET_FUNDING_AMOUNT)
      setText(status, 'Step 3/6: waiting for the funding to confirm')
      await waitForTransaction(sendTxId)

      setText(status, 'Step 4/6: waiting for the funding note')
      const noteId = await waitForFundingNote(client, faucetId)
      if (!noteId) throw new Error('The funding note did not arrive within the sync window.')

      setText(status, 'Step 5/6: consuming the note, which creates the faucet')
      await client.syncChain()
      await client.transactions.consume({
        account: faucetId,
        notes: [noteId],
        waitForConfirmation: true,
      })

      setText(status, 'Step 6/6: minting the whole supply')
      await client.syncChain()
      await client.transactions.mint({
        account: faucetId,
        to: wallet.toString(),
        amount: total,
        type: 'public',
        waitForConfirmation: true,
      })

      faucetLine.setAttribute('title', faucetId)
      setText(faucetLine, `${name} · ${shortHex(faucetId)}`)
      result.hidden = false
      setText(status, 'Minted')
      toast(`${name} minted: the whole supply is in your wallet.`)
    } catch (error) {
      console.error('[one-time-mint]', error)
      setText(status, error instanceof Error ? error.message : String(error))
    } finally {
      submit.disabled = false
    }
  }

}

/** Polls the client store for an input note an account can consume. */
async function waitForFundingNote(
  client: Awaited<ReturnType<typeof getClient>>,
  accountId: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await client.syncChain()
    const notes = await client.notes.listAvailable({ account: accountId })
    const id = notes[0]?.id()
    if (id) return id.toString()
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  return null
}