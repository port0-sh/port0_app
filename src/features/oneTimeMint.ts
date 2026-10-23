/**
 * Utility: launch a fixed-supply token.
 *
 * Creates a network faucet whose whole supply is minted once to the caller's
 * wallet, with `maxSupply` equal to that supply and an immutable owner, so
 * nothing remains to mint afterwards. It is the token-launch step from the pool
 * page, moved here because it is a general utility rather than part of creating a
 * pool.
 *
 * The six steps are forced by the chain: the faucet account must exist before it
 * can be funded, funding arrives as a note, that note is the faucet's first
 * transaction, and the launch is a separate note the owner's wallet emits.
 */

import { CONFIG } from '../lib/config'
import { FAUCET_DEPLOY_FEE_BASE_UNITS } from '../lib/fees'
import { chainNetworkId } from '../lib/network'
import { el, setText } from '../lib/dom'
import { shortHex } from '../lib/format'
import {
  DEFAULT_INITIAL_SUPPLY,
  NAME_MAX_CHARS,
  normalizeSymbol,
  parseInitialSupply,
  SYMBOL_MAX_LENGTH,
  SYMBOL_MIN_LENGTH,
  tokenNameOrDefault,
  validateDecimals,
  validateInitialSupply,
  validateSymbol,
  validateTokenName,
} from '../lib/token'
import { openModal } from '../ui/modal'
import { toast } from '../ui/toast'
import { getClient, sdkModule, xykModule } from '../lib/client'
import {
  sendViaWallet,
  submitViaWallet,
  waitForTransaction,
  walletAccountId,
} from '../wallet/wallet'

export function openOneTimeMint(): void {
  const symbol = el('input', {
    type: 'text',
    placeholder: 'MEME',
    minlength: SYMBOL_MIN_LENGTH,
    maxlength: SYMBOL_MAX_LENGTH,
    spellcheck: false,
    required: true,
  })
  // Optional: the faucet's display name, which wallets show next to the symbol.
  // Empty means "use the symbol", which is the standards' default.
  const tokenName = el('input', {
    type: 'text',
    placeholder: 'My Token',
    maxlength: NAME_MAX_CHARS,
    spellcheck: false,
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
    el(
      'span',
      { class: 'muted hint' },
      `${SYMBOL_MIN_LENGTH} to ${SYMBOL_MAX_LENGTH} uppercase letters, no digits.`,
    ),
    el('label', {}, 'Name'),
    tokenName,
    el(
      'span',
      { class: 'muted hint' },
      `Optional display name, up to ${NAME_MAX_CHARS} characters. Defaults to the symbol.`,
    ),
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
      const nameError = validateTokenName(tokenName.value)
      if (nameError) throw new Error(nameError)
      const ticker = normalizeSymbol(symbol.value)
      const name = tokenNameOrDefault(tokenName.value, ticker)

      const digits = Number(decimals.value)
      const decimalsError = validateDecimals(digits)
      if (decimalsError) throw new Error(decimalsError)

      // Bounded by the AMM contract's MAX_AMOUNT, not an arbitrary cap.
      const { MAX_AMOUNT } = await xykModule()
      const supplyError = validateInitialSupply(supply.value, digits, MAX_AMOUNT)
      if (supplyError) throw new Error(supplyError)
      const total = parseInitialSupply(supply.value, digits)

      const [{ AccountInterface }, client, chainId] = await Promise.all([
        sdkModule(),
        getClient(),
        chainNetworkId(),
      ])

      setText(status, 'Step 1/6: creating the faucet account')
      // A network account, so the faucet is exempt from any keyed-account
      // allowlist: launching a token needs no invitation code.
      const { createNetworkFaucet, LAUNCH_FEE, deployNetworkFaucet } = await xykModule()
      // The faucet pays its own deploy transaction, measured at 112 base units;
      // it has no sweep, so it is funded with exactly that. The launch is a
      // separate transaction, paid by this wallet's sponsorship.
      const funding = Number(FAUCET_DEPLOY_FEE_BASE_UNITS)
      const faucet = await createNetworkFaucet(client, {
        name,
        symbol: ticker,
        decimals: digits,
        maxSupply: total,
        owner: wallet,
        // Hex or bech32; the SDK resolves either.
        feeFaucetId: CONFIG.chainFeeFaucetId,
      })
      const faucetId = faucet.id().toString()

      // The client runs in a Web Worker with its own WASM instance, so every
      // call below takes the hex string rather than a main-thread handle.
      const faucetAddress = faucet.id().toBech32(chainId, AccountInterface.BasicWallet)
      setText(status, 'Step 2/6: asking the wallet to fund the faucet')
      const sendTxId = await sendViaWallet(faucetAddress, CONFIG.chainFeeFaucetId, funding)
      setText(status, 'Step 3/6: waiting for the funding to confirm')
      await waitForTransaction(sendTxId)

      setText(status, 'Step 4/6: waiting for the funding note')
      const noteId = await waitForFundingNote(client, faucetId)
      if (!noteId) throw new Error('The funding note did not arrive within the sync window.')

      setText(status, 'Step 5/6: consuming the note, which creates the faucet')
      await client.syncChain()
      await deployNetworkFaucet(client, faucet.id(), noteId, { waitForConfirmation: true })

      setText(status, 'Step 6/6: launching the token')
      // The whole supply leaves in one note the owner's wallet can accept. The
      // faucet enforces the owner and the one-launch rule on chain.
      const { buildLaunchNote, buildFeeSponsorshipNote, ownOutputNotesRequest } = await xykModule()
      const launch = buildLaunchNote({
        sender: wallet,
        faucetId: faucet.id(),
        recipient: wallet,
      })
      const sponsor = buildFeeSponsorshipNote({
        sender: wallet,
        target: faucet.id(),
        featureNote: launch,
        feeFaucetId: CONFIG.chainFeeFaucetId,
        feeAmount: LAUNCH_FEE,
      })
      // The wallet executes this request, so it takes the wallet variant: the
      // client-signed one omits the multisig auth-args preimage a guarded wallet
      // reads, and such a wallet aborts.
      const request = await ownOutputNotesRequest(client, [launch, sponsor], faucet.id())
      const launchTx = await submitViaWallet(request)
      await waitForTransaction(launchTx)

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