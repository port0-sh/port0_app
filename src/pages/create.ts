/**
 * Create pool page: launchpad + three-step pool deployment.
 *
 * Launchpad: mints a fixed-supply token to the creator's wallet (faucet with
 * maxSupply = initial supply, whole supply minted in one transaction). The
 * resulting faucet id can fill either token field with one click.
 *
 * Pool wizard, three irreversible steps, each marked as it completes:
 *   1. Build the pool account locally (createPoolAccount inserts it into the
 *      client store; nothing touches the chain).
 *   2. Deploy it with a scriptless transaction. Network accounts have no key
 *      and forbid tx scripts, so anyone can submit the deploy; the app's own
 *      client does it, no wallet needed.
 *   3. Send the admin configuration note from the creator's wallet. This one
 *      requires the wallet because the admin account signs it.
 *
 * Fee model: LP fee is one of the three Uniswap tiers (0.05% / 0.30% /
 * 1.00%). The protocol fee is 1/6 of the LP fee, sent to the platform fee
 * recipient from VITE_PROTOCOL_FEE_RECIPIENT; users never set it. Network
 * note fees are denominated in the configured USDC faucet asset.
 *
 * The SDK loads on first use; the page shell and the launchpad form render
 * without it.
 */

import type { NoteKind, PoolNoteFees } from 'miden-xyk-sdk'
import type { AccountId } from '@miden-sdk/miden-sdk'
import {
  getClient,
  getPublicAccount,
  getXyk,
  sdkModule,
  xykModule,
} from '../lib/client'
import { CONFIG } from '../lib/config'
import { qs, setText } from '../lib/dom'
import {
  DEFAULT_LP_FEE_BPS,
  protocolFeeBps,
  protocolFeeBpsDisplay,
} from '../lib/fees'
import { shortHex, withHexPrefix } from '../lib/format'
import { registry, type PoolRecord } from '../lib/registry'
import {
  DEFAULT_INITIAL_SUPPLY,
  normalizeSymbol,
  parseInitialSupply,
  validateDecimals,
  validateInitialSupply,
  validateSymbol,
} from '../lib/token'
import { toast } from '../ui/toast'
import { mountWallet } from '../wallet/ui'
import { mountTokenPicker, type TokenPicker } from '../features/tokenPicker'
import {
  sendViaWallet,
  submitViaWallet,
  syncWallet,
  waitForTransaction,
  walletAccountId,
  walletStore,
} from '../wallet/wallet'

const NOTE_KINDS: readonly NoteKind[] = ['admin', 'mint', 'burn', 'swap', 'collect']

/**
 * Measured 0.17 testnet fee per transaction: 133 base units (0.000133 USDCX).
 * Used for the pool's per-note-kind fee and the faucet funding note
 * (2 transactions: consume + mint).
 */
const TX_FEE_BASE_UNITS = 133n

/** Funding the faucet covers two transactions: 2 × 133 = 266. */
const FAUCET_FUNDING_AMOUNT = Number(TX_FEE_BASE_UNITS * 2n)

/** Funding the pool covers one transaction (the deploy consume): 133. */
const POOL_FUNDING_AMOUNT = Number(TX_FEE_BASE_UNITS)

mountWallet()

/* Launchpad. */

const launchForm = qs<HTMLFormElement>(document, '#launch-form')
const launchSymbol = qs<HTMLInputElement>(document, '#launch-symbol')
const launchDecimals = qs<HTMLInputElement>(document, '#launch-decimals')
const launchSupply = qs<HTMLInputElement>(document, '#launch-supply')
const launchSupplyRaw = qs<HTMLSpanElement>(document, '#launch-supply-raw')
const launchButton = qs<HTMLButtonElement>(document, '#launch-button')
const launchStatus = qs<HTMLSpanElement>(document, '#launch-status')
const launchResult = qs<HTMLDivElement>(document, '#launch-result')
const launchFaucetId = qs<HTMLSpanElement>(document, '#launch-faucet-id')
const launchUseToken0 = qs<HTMLButtonElement>(document, '#launch-use-token0')
const launchUseToken1 = qs<HTMLButtonElement>(document, '#launch-use-token1')

/* Pool parameters. */

const token0Input = qs<HTMLInputElement>(document, '#param-token0')
const token1Input = qs<HTMLInputElement>(document, '#param-token1')

// Wallet-token pickers; the text inputs stay the source of truth.
const token0Picker: TokenPicker = mountTokenPicker(
  'param-token0-select',
  'param-token0',
  'token0-toggle',
)
const token1Picker: TokenPicker = mountTokenPicker(
  'param-token1-select',
  'param-token1',
  'token1-toggle',
)

// Prevent picking the same token twice: each select disables the option the
// other one has selected.
const token0Select = qs<HTMLSelectElement>(document, '#param-token0-select')
const token1Select = qs<HTMLSelectElement>(document, '#param-token1-select')
function syncTokenExclusion(): void {
  for (const option of token0Select.options) {
    option.disabled = token1Select.value !== '' && option.value === token1Select.value
  }
  for (const option of token1Select.options) {
    option.disabled = token0Select.value !== '' && option.value === token0Select.value
  }
}
token0Select.addEventListener('change', syncTokenExclusion)
token1Select.addEventListener('change', syncTokenExclusion)
const feeTiers = qs<HTMLDivElement>(document, '#fee-tiers')
const protocolFeeDisplay = qs<HTMLSpanElement>(document, '#param-protocol-fee-display')
const feeRecipientDisplay = qs<HTMLSpanElement>(document, '#param-fee-recipient')

const stepAccount = qs<HTMLLIElement>(document, '#step-account')
const stepDeploy = qs<HTMLLIElement>(document, '#step-deploy')
const stepConfigure = qs<HTMLLIElement>(document, '#step-configure')
const deployError = qs<HTMLParagraphElement>(document, '#deploy-error')
const deployButton = qs<HTMLButtonElement>(document, '#deploy-button')
const deployStatus = qs<HTMLSpanElement>(document, '#deploy-status')
const deployResult = qs<HTMLParagraphElement>(document, '#deploy-result')
const deployResultLink = qs<HTMLAnchorElement>(document, '#deploy-result-link')

interface PoolParams {
  token0: AccountId
  token1: AccountId
  feeFaucet: AccountId
  lpFeeBps: bigint
  protocolFeeBps: bigint
  noteFees: PoolNoteFees
  feeTo: AccountId
}

interface FaucetMeta {
  id: AccountId
  symbol: string
  decimals: number
}

let launchedFaucetId: string | null = null
let createdPoolId: string | null = null
let running = false

/* Launchpad logic. */

function renderLaunchSupplyHint(): void {
  const raw = launchSupply.value.trim()
  const decimals = Number(launchDecimals.value)
  if (!raw || !Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    setText(launchSupplyRaw, '')
    return
  }
  try {
    const amount = parseInitialSupply(raw, decimals)
    setText(launchSupplyRaw, `= ${amount.toLocaleString('en-US')} base units`)
  } catch {
    setText(launchSupplyRaw, '')
  }
}

function renderLaunchGating(): void {
  launchButton.disabled = !walletStore.get().connected
  launchButton.textContent = walletStore.get().connected ? 'Mint token' : 'Login to launch'
}

launchForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void doLaunch()
})

launchSupply.addEventListener('input', renderLaunchSupplyHint)
launchDecimals.addEventListener('input', renderLaunchSupplyHint)

async function doLaunch(): Promise<void> {
  launchButton.disabled = true
  setText(launchStatus, '')
  try {
    const wallet = await walletAccountId()
    if (!wallet) throw new Error('Login first.')

    const symbolError = validateSymbol(launchSymbol.value)
    if (symbolError) throw new Error(symbolError)
    const symbol = normalizeSymbol(launchSymbol.value)

    const decimals = Number(launchDecimals.value)
    const decimalsError = validateDecimals(decimals)
    if (decimalsError) throw new Error(decimalsError)

    // Bound the supply by the XYK contract's MAX_AMOUNT, not an arbitrary cap.
    const { MAX_AMOUNT } = await xykModule()
    const supplyError = validateInitialSupply(launchSupply.value, decimals, MAX_AMOUNT)
    if (supplyError) throw new Error(supplyError)
    const supply = parseInitialSupply(launchSupply.value, decimals)

    const [{ NetworkId, AccountInterface }, client] = await Promise.all([
      sdkModule(),
      getClient(),
    ])

    // Step 1: faucet account, built locally.
    setText(launchStatus, 'Step 1/6: creating faucet account (local)')
    const faucet = await client.accounts.create({
      type: 'FungibleFaucet',
      storage: 'public',
      name: symbol,
      symbol,
      decimals,
      maxSupply: supply,
      // Permissionless: the whole supply is minted in one transaction and
      // maxSupply equals it, so nothing is left to mint afterwards. No auth
      // component keeps the account code small and browser execution fast.
    })

    // The client runs in a Web Worker with its own WASM instance. Every
    // client call below must pass the hex string, never a main-thread
    // AccountId/Account object, or the worker receives a foreign handle
    // and reports "null pointer passed to rust".
    const faucetIdHex = faucet.id().toString()

    // Step 2: the wallet funds the new faucet with the chain fee asset.
    const faucetAddress = faucet.id().toBech32(
      NetworkId.testnet(),
      AccountInterface.BasicWallet,
    )
    setText(launchStatus, 'Step 2/6: requesting faucet funding from wallet')
    const sendTxId = await sendViaWallet(
      faucetAddress,
      CONFIG.chainFeeFaucetId,
      FAUCET_FUNDING_AMOUNT,
    )
    setText(launchStatus, 'Step 3/6: waiting for funding to confirm')
    await waitForTransaction(sendTxId)

    // Step 3: consume the funding note (first tx) and mint the supply.
    setText(launchStatus, 'Step 4/6: waiting for funding note in sync')
    const noteId = await waitForFundingNote(client, faucetIdHex)
    if (!noteId) {
      throw new Error('Funding note not found within the sync window.')
    }

    setText(launchStatus, 'Step 5/6: consuming note (creates faucet on-chain)')
    await client.syncChain()
    await client.transactions.consume({
      account: faucetIdHex,
      notes: [noteId],
      waitForConfirmation: true,
    })

    setText(launchStatus, 'Step 6/6: minting initial supply')
    await client.syncChain()
    await client.transactions.mint({
      account: faucetIdHex,
      to: wallet.toString(),
      amount: supply,
      type: 'public',
      waitForConfirmation: true,
    })

    launchedFaucetId = faucetIdHex
    launchFaucetId.setAttribute('title', launchedFaucetId)
    setText(launchFaucetId, `${symbol} · ${shortHex(launchedFaucetId)}`)
    launchResult.hidden = false
    setText(launchStatus, 'Launched')
    launchSymbol.value = ''
    launchSupply.value = DEFAULT_INITIAL_SUPPLY
    renderLaunchSupplyHint()
    toast(`${symbol} launched: full supply minted to your wallet.`)
  } catch (error) {
    console.error('[launch]', error)
    setText(launchStatus, error instanceof Error ? error.message : String(error))
  } finally {
    renderLaunchGating()
  }
}

/** Polls the client store for an input note an account can consume. */
async function waitForFundingNote(
  client: Awaited<ReturnType<typeof getClient>>,
  accountIdHex: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await client.syncChain()
    const notes = await client.notes.listAvailable({ account: accountIdHex })
    const id = notes[0]?.id()
    if (id) {
      const idStr = id.toString()
      return idStr
    }
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  return null
}

launchUseToken0.addEventListener('click', () => {
  if (!launchedFaucetId) return
  token0Picker.setValue(launchedFaucetId)
  launchUseToken0.disabled = true
  launchUseToken0.textContent = 'Token 0 ✓'
  toast('Token 0 set to the launched token.')
})

launchUseToken1.addEventListener('click', () => {
  if (!launchedFaucetId) return
  token1Picker.setValue(launchedFaucetId)
  launchUseToken1.disabled = true
  launchUseToken1.textContent = 'Token 1 ✓'
  toast('Token 1 set to the launched token.')
})

/* Pool creation. */

/** Parses an account reference in hex or bech32 form. */
async function parseAccountRef(value: string, label: string): Promise<AccountId> {
  const { AccountId } = await sdkModule()
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is missing.`)
  try {
    return /^0x?[0-9a-f]+$/i.test(trimmed)
      ? AccountId.fromHex(withHexPrefix(trimmed))
      : AccountId.fromBech32(trimmed)
  } catch {
    throw new Error(`${label} is not a valid account id or address.`)
  }
}

function selectedFeeTierBps(): bigint {
  const checked = feeTiers.querySelector<HTMLInputElement>('input[name="lpFee"]:checked')
  return checked ? BigInt(checked.value) : DEFAULT_LP_FEE_BPS
}

async function readParams(): Promise<PoolParams> {
  const token0 = await parseAccountRef(token0Input.value, 'Token 0 faucet id')
  const token1 = await parseAccountRef(token1Input.value, 'Token 1 faucet id')
  if (token0.toString() === token1.toString()) {
    throw new Error('Token 0 and token 1 must be different faucets.')
  }
  // On 0.17 the network-note fee faucet must be the chain's own, so it is
  // read from the client, not from user input.
  const feeFaucet = await (await getClient()).feeFaucetId()
  // The per-note-kind fee is the measured transaction fee; not user-settable.
  const noteFees: PoolNoteFees = Object.fromEntries(
    NOTE_KINDS.map((kind) => [kind, TX_FEE_BASE_UNITS]),
  )
  const lpFeeBps = selectedFeeTierBps()
  return {
    token0,
    token1,
    feeFaucet,
    lpFeeBps,
    protocolFeeBps: protocolFeeBps(lpFeeBps),
    noteFees,
    feeTo: await parseAccountRef(CONFIG.protocolFeeRecipient, 'Protocol fee recipient'),
  }
}

async function faucetMeta(id: AccountId): Promise<FaucetMeta> {
  const { BasicFungibleFaucetComponent } = await sdkModule()
  const account = await getPublicAccount(id)
  const meta = BasicFungibleFaucetComponent.fromAccount(account)
  return { id, symbol: meta.symbol().toString(), decimals: meta.decimals() }
}

function setStep(step: HTMLLIElement, state: 'idle' | 'active' | 'done' | 'error', text: string): void {
  step.dataset.state = state
  setText(step.querySelector('span') ?? step, state === 'active' ? text : `— ${text}`)
}

function showDeployError(message: string): void {
  deployError.hidden = false
  setText(deployError, message)
}

function renderProtocolFee(): void {
  const tier = selectedFeeTierBps()
  setText(protocolFeeDisplay, protocolFeeBpsDisplay(tier))
}

function renderFeeRecipient(): void {
  if (CONFIG.protocolFeeRecipient) {
    setText(feeRecipientDisplay, CONFIG.protocolFeeRecipient)
  } else {
    feeRecipientDisplay.classList.add('error')
    setText(
      feeRecipientDisplay,
      'not configured — set VITE_PROTOCOL_FEE_RECIPIENT and rebuild',
    )
  }
}

function renderGating(): void {
  const recipientSet = CONFIG.protocolFeeRecipient.length > 0
  const connected = walletStore.get().connected
  if (!recipientSet) {
    deployButton.disabled = true
    deployButton.textContent = 'Set VITE_PROTOCOL_FEE_RECIPIENT to create'
  } else {
    deployButton.disabled = !connected
    deployButton.textContent = connected ? 'Create pool' : 'Login to create'
  }
}

deployButton.addEventListener('click', () => {
  void run()
})

async function run(): Promise<void> {
  if (running) return
  running = true
  deployButton.disabled = true
  deployError.hidden = true
  setText(deployStatus, '')
  try {
    const admin = await walletAccountId()
    if (!admin) throw new Error('Login first.')
    const params = await readParams()

    const [{ NetworkId, AccountInterface }, client, xyk] = await Promise.all([
      sdkModule(),
      getClient(),
      getXyk(),
    ])
    await client.syncChain()

    // Resolve token metadata before anything on-chain happens; a bad faucet
    // id fails here rather than after deployment.
    setStep(stepAccount, 'active', 'resolving token faucets…')
    const [token0Meta, token1Meta] = await Promise.all([
      faucetMeta(params.token0),
      faucetMeta(params.token1),
    ])

    // Step 1: local pool account.
    setStep(stepAccount, 'active', 'building pool account…')
    const { fungibleAssetIdWord } = await xykModule()
    const poolAccount = await xyk.createPoolAccount({
      token0Key: fungibleAssetIdWord(params.token0),
      token1Key: fungibleAssetIdWord(params.token1),
      admin,
      feeFaucetId: params.feeFaucet,
      noteFees: params.noteFees,
    })
    const poolId = poolAccount.id()
    createdPoolId = poolId.toString()
    setStep(stepAccount, 'done', `pool account ${shortHex(createdPoolId)}`)

    // Step 2: fund the pool and consume the note as its first transaction.
    // The 0.17 network auth rejects empty scriptless deploys (no effect), so
    // the pool commits on-chain by consuming a funding note, which also pays
    // its first transaction fee from the received funds.
    const poolAddress = poolId.toBech32(
      NetworkId.testnet(),
      AccountInterface.BasicWallet,
    )
    setStep(stepDeploy, 'active', 'requesting pool funding from wallet…')
    const poolSendTxId = await sendViaWallet(
      poolAddress,
      CONFIG.chainFeeFaucetId,
      POOL_FUNDING_AMOUNT,
    )
    await waitForTransaction(poolSendTxId)
    setStep(stepDeploy, 'active', 'waiting for funding note in sync…')
    const poolNoteId = await waitForFundingNote(client, createdPoolId)
    if (!poolNoteId) {
      throw new Error('Pool funding note not found within the sync window.')
    }
    setStep(stepDeploy, 'active', 'consuming note (creates pool on-chain)…')
    await xyk.deployPoolAccount(poolId, poolNoteId, { waitForConfirmation: true })
    setStep(stepDeploy, 'done', 'committed on-chain')

    // Step 3: admin configuration note via the wallet. A 0.17 multisig summary
    // binds the request's bound block, and the wallet's captured anchor is at
    // its own sync height; the two agree only when both are the same tip. Sync
    // last so the bound block is as close to the wallet's handling as possible.
    setStep(stepConfigure, 'active', 'requesting wallet signature…')
    await syncWallet()
    await client.syncChain()
    const config = {
      poolId,
      feeFaucetId: params.feeFaucet,
      noteFees: params.noteFees,
    }
    const pool = xyk.pool(config)
    const configParams = {
      sender: admin,
      feeTo: params.feeTo,
      lpFeeBps: params.lpFeeBps,
      protocolFeeBps: params.protocolFeeBps,
    }
    const txId = await submitViaWallet((await pool.configure(configParams)).request)
    setStep(stepConfigure, 'active', `submitted ${shortHex(txId)}; confirming…`)
    const { txHash } = await waitForTransaction(txId)
    setStep(stepConfigure, 'done', `configured (${shortHex(txHash)})`)

    const record: PoolRecord = {
      poolId: createdPoolId,
      feeFaucetId: params.feeFaucet.toString(),
      noteFees: Object.fromEntries(
        NOTE_KINDS.map((kind) => [kind, params.noteFees[kind]!.toString()]),
      ) as PoolRecord['noteFees'],
      token0FaucetId: token0Meta.id.toString(),
      token1FaucetId: token1Meta.id.toString(),
      token0Symbol: token0Meta.symbol,
      token1Symbol: token1Meta.symbol,
      token0Decimals: token0Meta.decimals,
      token1Decimals: token1Meta.decimals,
      addedAt: Date.now(),
    }
    registry.add(record)

    deployResult.hidden = false
    deployResultLink.href = `/pool.html?id=${encodeURIComponent(createdPoolId)}`
    toast(`Pool ${shortHex(createdPoolId)} created and configured.`)
    window.location.href = `/pool.html?id=${encodeURIComponent(createdPoolId)}`
  } catch (error) {
    console.error('[create-pool]', error)
    const message = error instanceof Error ? error.message : String(error)
    showDeployError(message)
    toast(message, 'error')
  } finally {
    running = false
    renderGating()
  }
}

/* Wire-up. */

feeTiers.addEventListener('change', renderProtocolFee)
renderProtocolFee()
renderFeeRecipient()
renderGating()
renderLaunchGating()
renderLaunchSupplyHint()
walletStore.subscribe(() => {
  renderGating()
  renderLaunchGating()
})
