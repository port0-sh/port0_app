/**
 * Create pool page: three-step pool deployment.
 *
 * Launchpad: mints a fixed-supply token to the creator's wallet (faucet with
 * maxSupply = initial supply, whole supply minted in one transaction). The
 * resulting faucet id can fill either token field with one click.
 *
 * Pool wizard, three irreversible steps, each marked as it completes:
 *   1. Build the pool account locally (createPoolAccount inserts it into the
 *      client store; nothing touches the chain).
 *   2. Fund it with a wallet note, then consume that note as the pool's first
 *      transaction. A 0.17 network auth rejects a transaction with no effect,
 *      so the funding note both commits the pool and pays its first fee. The
 *      app's own client submits the consume; the wallet sends the funding.
 *   3. Emit the register note from the creator's wallet. The registry verifies
 *      the pool code commitment and identity by foreign procedure invocation.
 *
 * Fee model: LP fee is one of the three Uniswap tiers (0.05% / 0.30% /
 * 1.00%); the registry lists the allowed tiers. The protocol's cut is a share
 * of the LP fee, read from the registry, and carved out of it. Network note
 * fees are denominated in the chain's fee asset.
 *
 * The SDK loads on first use; the page shell and the forms render
 * without it.
 */

import type { PoolNoteKind, PoolNoteFees } from '@port0.sh/sdk'
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
import { DEFAULT_LP_FEE_BPS } from '../lib/fees'
import type { RegistryFeePolicy } from '@port0.sh/sdk'
import { formatBps, isHexId, shortHex, withHexPrefix } from '../lib/format'

import { mountSiteChrome } from '../lib/site'
import { toast } from '../ui/toast'
import { mountWallet } from '../wallet/ui'
import { mountTokenPicker } from '../features/tokenPicker'
import {
  sendViaWallet,
  submitViaWallet,
  syncWallet,
  waitForTransaction,
  walletAccountId,
  walletStore,
} from '../wallet/wallet'

const NOTE_KINDS: readonly PoolNoteKind[] = ['mint', 'burn', 'swap', 'collect']

/**
 * Measured 0.17 testnet fee per transaction: 133 base units (0.000133 USDCX).
 * Used for the pool's per-note-kind fee and the faucet funding note
 * (2 transactions: consume + mint).
 */
const TX_FEE_BASE_UNITS = 133n

/** Funding the faucet covers two transactions: 2 × 133 = 266. */

/** Funding the pool covers one transaction (the deploy consume): 133. */
const POOL_FUNDING_AMOUNT = Number(TX_FEE_BASE_UNITS)

mountWallet()
mountSiteChrome()

/* Launchpad. */


/* Pool parameters. */


// Wallet-token pickers; the text inputs stay the source of truth. Mounted for
// their controls: the selection updates the inputs directly.
const token0Picker = mountTokenPicker('param-token0-select')
const token1Picker = mountTokenPicker('param-token1-select')

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
const feeBreakdown = qs<HTMLSpanElement>(document, '#param-fee-breakdown')

const stepAccount = qs<HTMLLIElement>(document, '#step-account')
const stepDeploy = qs<HTMLLIElement>(document, '#step-deploy')
const stepRegister = qs<HTMLLIElement>(document, '#step-register')
const resumeBanner = qs<HTMLParagraphElement>(document, '#resume-register')
const resumePoolId = qs<HTMLSpanElement>(document, '#resume-pool-id')
const resumeButton = qs<HTMLButtonElement>(document, '#resume-register-button')
const deployError = qs<HTMLParagraphElement>(document, '#deploy-error')
const deployButton = qs<HTMLButtonElement>(document, '#deploy-button')
const retryButton = qs<HTMLButtonElement>(document, '#retry-button')
const restartButton = qs<HTMLButtonElement>(document, '#restart-button')
const deployStatus = qs<HTMLSpanElement>(document, '#deploy-status')
const deployResult = qs<HTMLParagraphElement>(document, '#deploy-result')
const deployResultLink = qs<HTMLAnchorElement>(document, '#deploy-result-link')

interface PoolParams {
  token0: AccountId
  token1: AccountId
  feeFaucet: AccountId
  lpFeeBps: bigint
  protocolFeeShareBps: bigint
  noteFees: PoolNoteFees
  /** Registry the pool reads its protocol fee destination from. */
  registryId: AccountId
}

interface FaucetMeta {
  id: AccountId
  symbol: string
  decimals: number
}

let createdPoolId: string | null = null
let running = false

/** Stages of the create flow, in order. */
type Stage = 'account' | 'deploy' | 'register' | 'done'

/**
 * In-memory state of a create flow in progress.
 *
 * A failed stage keeps this object, so a retry resumes at the failed stage
 * instead of recreating the pool. `Restart flow` clears it.
 */
interface FlowState {
  admin: AccountId
  params: PoolParams
  token0Meta: FaucetMeta
  token1Meta: FaucetMeta
  poolId: AccountId | null
}

const STAGE_LABELS: Record<Stage, string> = {
  account: 'create account',
  deploy: 'deploy',
  register: 'register',
  done: 'done',
}

let flow: FlowState | null = null
let flowStage: Stage = 'account'

/** Shows the retry and restart controls for the stage that failed. */
function showStageRetry(): void {
  if (!flow) {
    retryButton.hidden = true
    restartButton.hidden = true
    return
  }
  setText(retryButton, `Retry ${STAGE_LABELS[flowStage]}`)
  retryButton.hidden = false
  restartButton.hidden = false
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

/* Pool creation. */

/** Parses an account reference in hex or bech32 form. */
async function parseAccountRef(value: string, label: string): Promise<AccountId> {
  const { AccountId } = await sdkModule()
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is missing.`)
  try {
    return isHexId(trimmed)
      ? AccountId.fromHex(withHexPrefix(trimmed))
      : AccountId.fromBech32(trimmed)
  } catch {
    throw new Error(`${label} is not a valid account id or address.`)
  }
}

/**
 * The registry's fee policy, read once per page.
 *
 * The pool's fee configuration is frozen at creation and validated against this
 * by the pool registry, so a pool built with anything else is rejected at
 * registration. Reading the policy here keeps the page and the registry in step.
 */
let registryPolicy: RegistryFeePolicy | null = null

async function loadRegistryPolicy(): Promise<RegistryFeePolicy> {
  if (registryPolicy) return registryPolicy
  const [{ readRegistryFeePolicy }, client] = await Promise.all([xykModule(), getClient()])
  const registryId = await parseAccountRef(CONFIG.registryId, 'Registry account id')
  // The registry is a public account this client may never have tracked, so it
  // is imported from the chain on demand. A store-only read reports a deployed
  // registry as not found.
  await client.syncChain()
  registryPolicy = await readRegistryFeePolicy(
    (id) => getPublicAccount(id),
    registryId,
  )
  return registryPolicy
}

function selectedFeeTierBps(): bigint {
  const checked = feeTiers.querySelector<HTMLInputElement>('input[name="lpFee"]:checked')
  return checked ? BigInt(checked.value) : DEFAULT_LP_FEE_BPS
}

async function readParams(): Promise<PoolParams> {
  if (token0Select.value === '' || token1Select.value === '') {
    throw new Error('Pick both tokens from your wallet.')
  }
  const token0 = await parseAccountRef(token0Select.value, 'Token 0 faucet id')
  const token1 = await parseAccountRef(token1Select.value, 'Token 1 faucet id')
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
  const registryId = await parseAccountRef(CONFIG.registryId, 'Registry account id')
  const policy = await loadRegistryPolicy()
  if (!policy.allowedLpFeeBps.some((tier: bigint) => tier === lpFeeBps)) {
    throw new Error(
      `The registry does not list ${lpFeeBps.toString()} bps as an LP fee tier.`,
    )
  }
  return {
    token0,
    token1,
    feeFaucet,
    lpFeeBps,
    protocolFeeShareBps: policy.protocolFeeShareBps,
    noteFees,
    registryId,
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

function renderFeeBreakdown(): void {
  const tier = selectedFeeTierBps()
  // Until the registry answers, state what is known: the LP fee.
  const protocol = registryPolicy
    ? `${formatBps(registryPolicy.protocolFeeShareBps)} to the protocol`
    : 'protocol fee read from the registry'
  setText(feeBreakdown, `Swap fee: ${formatBps(tier)} to LPs · ${protocol}.`)
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
  retryButton.hidden = true
  restartButton.hidden = true
  deployError.hidden = true
  setText(deployStatus, '')
  try {
    if (!flow) {
      const admin = await walletAccountId()
      if (!admin) throw new Error('Login first.')
      const params = await readParams()
      await (await getClient()).syncChain()

      // Resolve token metadata before anything on-chain happens; a bad faucet
      // id fails here rather than after deployment.
      setStep(stepAccount, 'active', 'resolving token faucets…')
      const [token0Meta, token1Meta] = await Promise.all([
        faucetMeta(params.token0),
        faucetMeta(params.token1),
      ])
      flow = { admin, params, token0Meta, token1Meta, poolId: null }
      flowStage = 'account'
    }
    const { admin, params, token0Meta, token1Meta } = flow
    const [{ NetworkId, AccountInterface }, client, xyk] = await Promise.all([
      sdkModule(),
      getClient(),
      getXyk(),
    ])

    // Stage: local pool account.
    if (flowStage === 'account') {
      setStep(stepAccount, 'active', 'building pool account…')
      const { fungibleAssetIdWord } = await xykModule()
      const poolAccount = await xyk.createPoolAccount({
        token0Key: fungibleAssetIdWord(params.token0),
        token1Key: fungibleAssetIdWord(params.token1),
        registryId: params.registryId,
        lpFeeBps: BigInt(params.lpFeeBps),
        protocolFeeShareBps: BigInt(params.protocolFeeShareBps),
        feeFaucetId: params.feeFaucet,
        noteFees: params.noteFees,
      })
      flow.poolId = poolAccount.id()
      createdPoolId = flow.poolId.toString()
      setStep(stepAccount, 'done', `pool account ${shortHex(createdPoolId)}`)
      flowStage = 'deploy'
    }

    // Stage: fund the pool and consume the note as its first transaction. The
    // 0.17 network auth rejects empty scriptless deploys (no effect), so the
    // pool commits on-chain by consuming a funding note, which also pays its
    // first transaction fee from the received funds.
    if (flowStage === 'deploy') {
      const poolId = flow.poolId
      if (!poolId) throw new Error('Pool account is missing; restart the flow.')

      // Reuse a funding note from an earlier attempt rather than sending again.
      const existing =
        (await client.notes.listAvailable({ account: poolId.toString() })) ?? []
      const firstNote = existing[0]
      let poolNoteId: string | null = null
      if (firstNote) {
        const noteId = firstNote.id()
        if (noteId) {
          poolNoteId = noteId.toString()
        }
      }
      if (!poolNoteId) {
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
        poolNoteId = await waitForFundingNote(client, poolId.toString())
      }
      if (!poolNoteId) {
        throw new Error('Pool funding note not found within the sync window.')
      }
      setStep(stepDeploy, 'active', 'consuming note (creates pool on-chain)…')
      await xyk.deployPoolAccount(poolId, poolNoteId, { waitForConfirmation: true })
      setStep(stepDeploy, 'done', 'committed on-chain')
      flowStage = 'register'
    }

    // Stage: register the pool on the on-chain registry. The register note is
    // a network note consumed by the registry account; the node's transaction
    // builder verifies the pool code commitment by FPI.
    if (flowStage === 'register') {
      const poolId = flow.poolId
      if (!poolId) throw new Error('Pool account is missing; restart the flow.')
      rememberPoolDraft(poolId.toString())
      if (CONFIG.registryId.length > 0) {
        await registerPoolOnRegistry({
          poolId,
          admin,
          token0: token0Meta.id,
          token1: token1Meta.id,
        })
        clearDraft()
      } else {
        setStep(stepRegister, 'done', 'skipped: no registry configured')
      }
      flowStage = 'done'
    }

    if (!createdPoolId) throw new Error('Pool account is missing.')
    deployResult.hidden = false
    deployResultLink.href = `/pool.html?id=${encodeURIComponent(createdPoolId)}`
    toast(`Pool ${shortHex(createdPoolId)} created and registered.`)
    flow = null
    flowStage = 'account'
    window.location.href = `/pool.html?id=${encodeURIComponent(createdPoolId)}`
  } catch (error) {
    console.error('[create-pool]', error)
    const message = error instanceof Error ? error.message : String(error)
    showDeployError(message)
    toast(message, 'error')
    showStageRetry()
  } finally {
    running = false
    renderGating()
  }
}

/* Register step and create-page draft. */

const DRAFT_KEY = 'port0-app:create-draft:v1'

interface CreateDraft {
  token0?: string
  token1?: string
  lpFeeBps?: string
  poolId?: string
}

function readDraft(): CreateDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as CreateDraft) : {}
  } catch {
    return {}
  }
}

function writeDraft(patch: Partial<CreateDraft>): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...readDraft(), ...patch }))
  } catch {
    // Private mode or quota. The draft is a convenience, not state.
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Ignore.
  }
}

/** Saves the form inputs, so a reload after an error keeps the parameters. */
function saveFormDraft(): void {
  writeDraft({
    token0: token0Select.value,
    token1: token1Select.value,
    lpFeeBps: selectedFeeTierBps().toString(),
  })
}

/** Records a deployed pool that has not registered yet. */
function rememberPoolDraft(poolId: string): void {
  writeDraft({ poolId })
}

/** Restores the form inputs and the pending-registration banner. */
function restoreDraft(): void {
  const draft = readDraft()
  if (draft.token0) token0Picker.setValue(draft.token0)
  if (draft.token1) token1Picker.setValue(draft.token1)
  if (draft.lpFeeBps) {
    const radio = feeTiers.querySelector<HTMLInputElement>(
      `input[name="lpFee"][value="${draft.lpFeeBps}"]`,
    )
    if (radio) radio.checked = true
  }
  if (draft.poolId) {
    resumeBanner.hidden = false
    setText(resumePoolId, shortHex(draft.poolId))
  }
}

/**
 * Emits the register note for a pool and waits for the wallet to confirm it.
 *
 * The register note package is deserialized before the sync on purpose. The
 * request's bound block is read from the client's sync height at build time,
 * and the wallet captures its anchor at its own sync height when it handles
 * the request. A first-use deserialization between the sync and the submit
 * takes long enough for a block to land, and Bread then rejects the summary
 * with `SummaryAnchorMismatchError`. Warm the package, then sync last.
 */
async function registerPoolOnRegistry(params: {
  poolId: AccountId
  admin: AccountId
  token0: AccountId
  token1: AccountId
}): Promise<void> {
  const [xykSdk, client, xyk] = await Promise.all([
    xykModule(),
    getClient(),
    getXyk(),
  ])
  setStep(stepRegister, 'active', 'loading note script…')
  xykSdk.noteScript('register')
  setStep(stepRegister, 'active', 'requesting wallet signature…')
  await syncWallet()
  await client.syncChain()
  const registerResult = await xyk.registerPool(
    {
      registryId: await parseAccountRef(CONFIG.registryId, 'Pool registry'),
      feeFaucetId: await client.feeFaucetId(),
      registerFee: BigInt(CONFIG.registryRegisterFee),
    },
    {
      sender: params.admin,
      poolId: params.poolId,
      asset0: params.token0,
      asset1: params.token1,
    },
  )
  const registerTxId = await submitViaWallet(registerResult.request)
  setStep(stepRegister, 'active', `submitted ${shortHex(registerTxId)}; registering…`)
  const { txHash } = await waitForTransaction(registerTxId)
  setStep(stepRegister, 'done', `emitted (${shortHex(txHash)})`)
}

/** Finishes registration for a pool deployed in a previous session. */
async function resumeRegistration(): Promise<void> {
  // The draft is the pool's own record of its tokens, and it is the only source
  // this path can trust: the wallet may hold a different pair by now, and the
  // pool was created from the pair the draft names.
  const draft = readDraft()
  if (!draft.poolId || !draft.token0 || !draft.token1) return
  try {
    const admin = await walletAccountId()
    if (!admin) throw new Error('Login first.')
    const [{ AccountId }, token0, token1] = await Promise.all([
      sdkModule(),
      parseAccountRef(draft.token0, 'Token 0 faucet id'),
      parseAccountRef(draft.token1, 'Token 1 faucet id'),
    ])
    await registerPoolOnRegistry({
      poolId: AccountId.fromHex(withHexPrefix(draft.poolId)),
      admin,
      token0,
      token1,
    })
    clearDraft()
    toast('Pool registered.')
    window.location.href = `/pool.html?id=${encodeURIComponent(draft.poolId)}`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showDeployError(message)
    toast(message, 'error')
  }
}

/* Wire-up. */

feeTiers.addEventListener('change', renderFeeBreakdown)
feeTiers.addEventListener('change', saveFormDraft)
token0Select.addEventListener('change', saveFormDraft)
token1Select.addEventListener('change', saveFormDraft)
resumeButton.addEventListener('click', () => {
  void resumeRegistration()
})
retryButton.addEventListener('click', () => {
  void run()
})
restartButton.addEventListener('click', () => {
  flow = null
  flowStage = 'account'
  retryButton.hidden = true
  restartButton.hidden = true
  clearDraft()
  void run()
})
restoreDraft()
renderFeeBreakdown()
renderGating()
walletStore.subscribe(() => {
  renderGating()
})
