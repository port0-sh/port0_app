/**
 * Pool detail page: on-chain state summary plus the three pool actions
 * (swap, add liquidity, remove liquidity).
 *
 * The page shell renders without the SDK; the stack loads on first state
 * fetch and stays cached. Quoting is local and exact: the SDK's math
 * functions run against the latest fetched pool state. Submissions are
 * built with `submit: false` and handed to the connected wallet, which
 * signs, submits and confirms.
 */

import type { Pool, PoolConfig, PoolState } from 'miden-xyk-sdk'
import type { AccountId } from '@miden-sdk/miden-sdk'
import {
  getClient,
  getXyk,
  sdkModule,
  xykModule,
  type XykModule,
} from '../lib/client'
import { clear, el, qs, setText } from '../lib/dom'
import { formatAmount, formatBps, normalizeHex, parseAmount, shortHex, withHexPrefix } from '../lib/format'
import { registry, type PoolRecord } from '../lib/registry'
import { toast } from '../ui/toast'
import { mountWallet } from '../wallet/ui'
import {
  requestAssets,
  submitViaWallet,
  syncWallet,
  waitForTransaction,
  walletAccountId,
  walletStore,
} from '../wallet/wallet'

/**
 * Deadline margin, seconds. Miden block timestamps are wall-clock epoch
 * seconds. The deadline is the maximum of the wall clock and the pool's
 * last-seen block timestamp, plus this margin, so both client clock skew and
 * note settlement delay are absorbed. 3600 = one hour.
 */
const DEADLINE_MARGIN_SECONDS = 3600n

mountWallet()

const poolIdParam = new URLSearchParams(window.location.search).get('id')
const poolIdHex = poolIdParam ? normalizeHex(poolIdParam) : null

const pairTitle = qs<HTMLElement>(document, '#pool-pair')
const poolIdLine = qs<HTMLElement>(document, '#pool-id')
const poolError = qs<HTMLParagraphElement>(document, '#pool-error')
const statReserve0 = qs<HTMLElement>(document, '#stat-reserve0')
const statReserve1 = qs<HTMLElement>(document, '#stat-reserve1')
const statPrice = qs<HTMLElement>(document, '#stat-price')
const statLpFee = qs<HTMLElement>(document, '#stat-lp-fee')
const statProtocolFee = qs<HTMLElement>(document, '#stat-protocol-fee')
const statLpSupply = qs<HTMLElement>(document, '#stat-lp-supply')

const swapForm = qs<HTMLFormElement>(document, '#swap-form')
const swapSide = qs<HTMLSelectElement>(document, '#swap-side')
const swapAmount = qs<HTMLInputElement>(document, '#swap-amount')
const swapSlippage = qs<HTMLInputElement>(document, '#swap-slippage')
const swapQuote = qs<HTMLDivElement>(document, '#swap-quote')
const swapSubmit = qs<HTMLButtonElement>(document, '#swap-submit')
const swapStatus = qs<HTMLSpanElement>(document, '#swap-status')

const addForm = qs<HTMLFormElement>(document, '#add-form')
const addAmount0 = qs<HTMLInputElement>(document, '#add-amount0')
const addAmount1 = qs<HTMLInputElement>(document, '#add-amount1')
const addSlippage = qs<HTMLInputElement>(document, '#add-slippage')
const addQuote = qs<HTMLDivElement>(document, '#add-quote')
const addSubmit = qs<HTMLButtonElement>(document, '#add-submit')
const addStatus = qs<HTMLSpanElement>(document, '#add-status')

const removeForm = qs<HTMLFormElement>(document, '#remove-form')
const removeLp = qs<HTMLInputElement>(document, '#remove-lp')
const removeSlippage = qs<HTMLInputElement>(document, '#remove-slippage')
const removeQuote = qs<HTMLDivElement>(document, '#remove-quote')
const removeSubmit = qs<HTMLButtonElement>(document, '#remove-submit')
const removeStatus = qs<HTMLSpanElement>(document, '#remove-status')

let record: PoolRecord | null = null
let currentState: PoolState | null = null

async function boot(): Promise<void> {
  if (!poolIdHex) {
    showPoolError('No pool id in the URL. Use ?id=<pool account id>.')
    return
  }
  record = registry.get(poolIdHex) ?? null
  if (!record) {
    showPoolError('This pool is not in the local registry. Import it from the pools page first.')
    return
  }
  setText(pairTitle, `${record.token0Symbol} / ${record.token1Symbol}`)
  setText(poolIdLine, poolIdHex)
  poolIdLine.setAttribute('title', poolIdHex)
  if (record.feeFaucetId === null) {
    toast(
      'Pool imported without its fee faucet id: trading is disabled. Pools created with this app are fully enabled.',
      'error',
      12000,
    )
  }
  setupTabs()
  setupForms()
  renderWalletGating()
  walletStore.subscribe(() => {
    renderWalletGating()
    void refreshBalances()
  })
  await loadState()
  await refreshBalances()
}

function showPoolError(message: string): void {
  poolError.hidden = false
  setText(poolError, message)
}

async function loadState(): Promise<void> {
  if (!poolIdHex) return
  try {
    const [{ decodePoolState }, { AccountId }, client] = await Promise.all([
      xykModule(),
      sdkModule(),
      getClient(),
    ])
    // Sync first: the local store is a cache of chain state.
    await client.syncChain()
    const account = await client.accounts.getOrImport(
      AccountId.fromHex(withHexPrefix(poolIdHex)),
    )
    currentState = decodePoolState(account)
    populateSwapSide()
    await recomputeQuotes()
    renderSummary()
  } catch (error) {
    showPoolError(
      `Failed to load pool state: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function renderSummary(): void {
  if (!currentState || !record) return
  const state = currentState
  setText(statReserve0, formatAmount(state.reserve0, record.token0Decimals))
  setText(statReserve1, formatAmount(state.reserve1, record.token1Decimals))
  setText(statPrice, priceToken0InToken1(state) ?? '—')
  setText(statLpFee, formatBps(state.fees.lpFeeBps))
  setText(statProtocolFee, formatBps(state.fees.protocolFeeBps))
  setText(statLpSupply, state.lpSupply.toString())
}

/**
 * Price of 1 token0 in token1, computed with the contract's own formula at
 * zero fees: amountOut(10^d0, r0, r1, 0, 0). Returns null on an empty pool.
 */
function priceToken0InToken1(state: PoolState): string | null {
  if (!record || state.reserve0 === 0n || state.reserve1 === 0n) return null
  const raw = currentQuoteModule()?.amountOut(
    10n ** BigInt(record.token0Decimals),
    state.reserve0,
    state.reserve1,
    0n,
    0n,
  )
  if (!raw) return null
  return trimFraction(formatAmount(raw.amountOut, record.token1Decimals))
}

/** The XYK module, if already loaded. Null when quotes have never run. */
let loadedXykModule: XykModule | null = null

function currentQuoteModule(): XykModule | null {
  return loadedXykModule
}

function trimFraction(value: string, maxFractionDigits = 6): string {
  const [intPart, frac = ''] = value.split('.')
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, '')
  return trimmed ? `${intPart}.${trimmed}` : intPart
}

function populateSwapSide(): void {
  if (!currentState || !record) return
  clear(swapSide)
  swapSide.append(
    el('option', { value: currentState.token0FaucetId.toString() }, record.token0Symbol),
    el('option', { value: currentState.token1FaucetId.toString() }, record.token1Symbol),
  )
}

/* Tabs: hash-based, no client-side router. */

const TABS = ['swap', 'add', 'remove'] as const

function currentTab(): string {
  const hash = window.location.hash.replace('#', '')
  return TABS.includes(hash as (typeof TABS)[number]) ? hash : 'swap'
}

function setupTabs(): void {
  const apply = (): void => {
    const tab = currentTab()
    for (const name of TABS) {
      qs<HTMLElement>(document, `#tab-${name}`).hidden = name !== tab
      for (const link of document.querySelectorAll<HTMLAnchorElement>(`a[data-tab="${name}"]`)) {
        link.classList.toggle('active', name === tab)
      }
    }
  }
  window.addEventListener('hashchange', apply)
  apply()
}

/* Forms: local quotes on input, wallet submission on submit. */

function setupForms(): void {
  swapForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void doSwap()
  })
  for (const input of [swapAmount, swapSlippage, swapSide]) {
    input.addEventListener('input', () => {
      void recomputeQuotes()
    })
  }
  swapSide.addEventListener('change', renderBalanceLines)
  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void doAdd()
  })
  for (const input of [addAmount0, addAmount1, addSlippage]) {
    input.addEventListener('input', () => {
      void recomputeQuotes()
    })
  }
  removeForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void doRemove()
  })
  for (const input of [removeLp, removeSlippage]) {
    input.addEventListener('input', () => {
      void recomputeQuotes()
    })
  }

  attachAmountControls(
    swapAmount,
    () => currentSideFaucetId(),
    () => currentSideSymbol(),
    () => currentSideDecimals(),
  )
  attachAmountControls(
    addAmount0,
    () => record?.token0FaucetId ?? null,
    () => record?.token0Symbol ?? '',
    () => record?.token0Decimals ?? 0,
  )
  attachAmountControls(
    addAmount1,
    () => record?.token1FaucetId ?? null,
    () => record?.token1Symbol ?? '',
    () => record?.token1Decimals ?? 0,
  )
  attachAmountControls(
    removeLp,
    () => poolIdHex,
    () => 'LP',
    () => 0,
  )
}

/* Balances and amount shortcuts. */

let balances = new Map<string, bigint>()

interface AmountControl {
  line: HTMLSpanElement
  getFaucetId: () => string | null
  getSymbol: () => string
  getDecimals: () => number
}

const amountControls: AmountControl[] = []

function balanceOf(faucetId: string): bigint {
  return balances.get(normalizeHex(faucetId)) ?? 0n
}

function attachAmountControls(
  input: HTMLInputElement,
  getFaucetId: () => string | null,
  getSymbol: () => string,
  getDecimals: () => number,
): void {
  const line = el('span', { class: 'muted balance-line' })
  const buttons = el(
    'div',
    { class: 'pct-buttons' },
    ...[25n, 50n, 75n, 100n].map((pct) =>
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => fillPercent(input, pct, getFaucetId(), getDecimals()),
        },
        pct === 100n ? 'Max' : `${pct}%`,
      ),
    ),
  )
  input.after(buttons, line)
  amountControls.push({ line, getFaucetId, getSymbol, getDecimals })
}

function fillPercent(
  input: HTMLInputElement,
  pct: bigint,
  faucetId: string | null,
  decimals: number,
): void {
  if (!faucetId) return
  const balance = balanceOf(faucetId)
  if (balance === 0n) return
  input.value = formatAmount((balance * pct) / 100n, decimals)
  void recomputeQuotes()
}

function renderBalanceLines(): void {
  for (const control of amountControls) {
    const faucetId = control.getFaucetId()
    if (!faucetId) {
      control.line.textContent = ''
      continue
    }
    const balance = balanceOf(faucetId)
    const symbol = control.getSymbol()
    control.line.textContent = `Balance: ${formatAmount(balance, control.getDecimals())}${symbol ? ` ${symbol}` : ''}`
  }
}

function currentSide(): 0 | 1 {
  return currentState && currentState.token0FaucetId.toString() === swapSide.value ? 0 : 1
}

function currentSideFaucetId(): string | null {
  if (!currentState) return null
  return currentSide() === 0
    ? currentState.token0FaucetId.toString()
    : currentState.token1FaucetId.toString()
}

function currentSideSymbol(): string {
  if (!record) return ''
  return currentSide() === 0 ? record.token0Symbol : record.token1Symbol
}

function currentSideDecimals(): number {
  if (!record) return 0
  return currentSide() === 0 ? record.token0Decimals : record.token1Decimals
}

async function refreshBalances(): Promise<void> {
  if (!walletStore.get().connected) {
    balances = new Map()
    renderBalanceLines()
    return
  }
  try {
    const { AccountId } = await sdkModule()
    const assets = await requestAssets()
    const entries = assets.map((asset) => {
      const raw = asset.faucetId.trim()
      const hex = /^0x?[0-9a-f]+$/i.test(raw)
        ? normalizeHex(raw)
        : normalizeHex(AccountId.fromBech32(raw).toString())
      return [hex, BigInt(asset.amount)] as const
    })
    balances = new Map(entries)
  } catch {
    balances = new Map()
  }
  renderBalanceLines()
}

function quoteError(message: string): Node {
  return el('p', { class: 'error' }, message)
}

async function recomputeQuotes(): Promise<void> {
  loadedXykModule = await xykModule()
  renderSwapQuote()
  renderAddQuote()
  renderRemoveQuote()
}

function slippageInput(input: HTMLInputElement): bigint {
  const value = Number(input.value)
  if (!Number.isInteger(value) || value < 0 || value > 9999) {
    throw new RangeError('Slippage must be an integer in [0, 9999] bps.')
  }
  return BigInt(value)
}

function renderSwapQuote(): void {
  clear(swapQuote)
  if (!currentState || !record || !loadedXykModule) return
  const { amountOut, applySlippage } = loadedXykModule
  const state = currentState
  const side = currentState.token0FaucetId.toString() === swapSide.value ? 0 : 1
  const decimalsIn = side === 0 ? record.token0Decimals : record.token1Decimals
  const decimalsOut = side === 0 ? record.token1Decimals : record.token0Decimals
  const symbolIn = side === 0 ? record.token0Symbol : record.token1Symbol
  const symbolOut = side === 0 ? record.token1Symbol : record.token0Symbol
  const reserveIn = side === 0 ? state.reserve0 : state.reserve1
  const reserveOut = side === 0 ? state.reserve1 : state.reserve0

  if (!swapAmount.value) {
    swapQuote.append(el('p', { class: 'muted' }, 'Enter an amount to see the quote.'))
    return
  }

  try {
    const amountIn = parseAmount(swapAmount.value, decimalsIn)
    const slippageBps = slippageInput(swapSlippage)
    if (amountIn === 0n) {
      throw new RangeError('Amount must be positive.')
    }
    const quote = amountOut(
      amountIn,
      reserveIn,
      reserveOut,
      state.fees.lpFeeBps,
      state.fees.protocolFeeBps,
    )
    const minOut = applySlippage(quote.amountOut, slippageBps)
    const rateRaw = amountOut(10n ** BigInt(decimalsIn), reserveIn, reserveOut, 0n, 0n).amountOut
    const impactBps = (amountIn * 10000n) / (reserveIn + amountIn)
    const impact = formatBps(impactBps)

    const lines: Node[] = [
      el(
        'p',
        {},
        `Rate: 1 ${symbolIn} = ${trimFraction(formatAmount(rateRaw, decimalsOut))} ${symbolOut}`,
      ),
      el(
        'p',
        {},
        `You receive: ${formatAmount(quote.amountOut, decimalsOut)} ${symbolOut}`,
      ),
      el('p', {}, `Minimum out (slippage ${slippageBps} bps): ${formatAmount(minOut, decimalsOut)} ${symbolOut}`),
      el('p', { class: 'muted' }, `Price impact: ${impact}`),
    ]
    if (impactBps > 500n) {
      lines.push(el('p', { class: 'error' }, 'Price impact above 5%.'))
    }
    swapQuote.append(...lines)
  } catch (error) {
    swapQuote.append(quoteError(error instanceof Error ? error.message : String(error)))
  }
}

function renderAddQuote(): void {
  clear(addQuote)
  if (!currentState || !record || !loadedXykModule) return
  const { quoteMint, applySlippage } = loadedXykModule
  const state = currentState

  if (!addAmount0.value || !addAmount1.value) {
    addQuote.append(el('p', { class: 'muted' }, 'Enter amounts to see the quote.'))
    return
  }

  try {
    const amount0 = parseAmount(addAmount0.value, record.token0Decimals)
    const amount1 = parseAmount(addAmount1.value, record.token1Decimals)
    const slippageBps = slippageInput(addSlippage)
    if (amount0 === 0n || amount1 === 0n) {
      throw new RangeError('Both amounts must be positive.')
    }
    const quote = quoteMint(amount0, amount1, state.reserve0, state.reserve1, state.lpSupply)
    const minLp = applySlippage(quote.liquidityToUser, slippageBps)

    const lines: Node[] = [
      el('p', {}, `LP you receive: ${quote.liquidityToUser.toString()}`),
      el('p', {}, `Minimum LP (slippage ${slippageBps} bps): ${minLp.toString()}`),
    ]
    if (quote.refund0 > 0n) {
      lines.push(el('p', {}, `Refund: ${formatAmount(quote.refund0, record.token0Decimals)} ${record.token0Symbol}`))
    }
    if (quote.refund1 > 0n) {
      lines.push(el('p', {}, `Refund: ${formatAmount(quote.refund1, record.token1Decimals)} ${record.token1Symbol}`))
    }
    addQuote.append(...lines)
  } catch (error) {
    addQuote.append(quoteError(error instanceof Error ? error.message : String(error)))
  }
}

function renderRemoveQuote(): void {
  clear(removeQuote)
  if (!currentState || !record || !loadedXykModule) return
  const { quoteBurn, applySlippage } = loadedXykModule
  const state = currentState

  if (!removeLp.value) {
    removeQuote.append(el('p', { class: 'muted' }, 'Enter an LP amount to see the quote.'))
    return
  }

  try {
    const lpAmount = parseAmount(removeLp.value, 0)
    const slippageBps = slippageInput(removeSlippage)
    if (lpAmount === 0n) {
      throw new RangeError('Amount must be positive.')
    }
    if (state.lpSupply === 0n) {
      throw new RangeError('Pool has no LP supply.')
    }
    const quote = quoteBurn(lpAmount, state.reserve0, state.reserve1, state.lpSupply)
    const min0 = applySlippage(quote.amount0, slippageBps)
    const min1 = applySlippage(quote.amount1, slippageBps)

    removeQuote.append(
      el(
        'p',
        {},
        `You receive: ${formatAmount(quote.amount0, record.token0Decimals)} ${record.token0Symbol} / `,
        `${formatAmount(quote.amount1, record.token1Decimals)} ${record.token1Symbol}`,
      ),
      el(
        'p',
        {},
        `Minimum out (slippage ${slippageBps} bps): ${formatAmount(min0, record.token0Decimals)} ${record.token0Symbol} / `,
        `${formatAmount(min1, record.token1Decimals)} ${record.token1Symbol}`,
      ),
    )
  } catch (error) {
    removeQuote.append(quoteError(error instanceof Error ? error.message : String(error)))
  }
}

/* Wallet gating and submission. */

function renderWalletGating(): void {
  const connected = walletStore.get().connected
  const enabled = connected && record?.feeFaucetId != null
  console.log('[pool] gating', { connected, feeFaucetId: record?.feeFaucetId ?? null })

  for (const button of [swapSubmit, addSubmit, removeSubmit]) {
    button.disabled = !enabled
    button.textContent = enabled ? 'Submit' : 'Login to act'
  }
  if (!connected) {
    setText(swapStatus, 'Login to act on this pool.')
  }
}

/** The wallet's account id parsed from its reported address. */
async function senderAccountId(): Promise<AccountId> {
  const id = await walletAccountId()
  if (!id) throw new Error('Login first.')
  return id
}

function computeDeadline(): bigint {
  const wallClock = BigInt(Math.floor(Date.now() / 1000))
  const chainFloor = currentState?.blockTimestampLast ?? 0n
  const latest = wallClock > chainFloor ? wallClock : chainFloor
  return latest + DEADLINE_MARGIN_SECONDS
}

async function poolHandle(): Promise<Pool> {
  if (!record) throw new Error('Pool record missing.')
  if (!record.feeFaucetId) {
    throw new Error(
      'Trading is disabled for this pool: it was imported without its fee faucet id.',
    )
  }
  const { AccountId } = await sdkModule()
  const config: PoolConfig = {
    poolId: AccountId.fromHex(withHexPrefix(record.poolId)),
    feeFaucetId: AccountId.fromHex(withHexPrefix(record.feeFaucetId)),
    noteFees: Object.fromEntries(
      Object.entries(record.noteFees).map(([kind, amount]) => [kind, BigInt(amount)]),
    ) as PoolConfig['noteFees'],
  }
  return (await getXyk()).pool(config)
}

/** Re-fetches the pool account so the next quote or op builds on fresh state. */
/**
 * Re-fetches the pool account so the next quote or op builds on fresh state.
 *
 * `syncChain()` is the last network call: the request's bound block is read as
 * `client.getSyncHeight()` when the op builds, and the wallet captures its
 * anchor at its own sync height during `requestTransaction`. Every call between
 * the sync and the submit widens the window in which a block can land and put
 * the two blocks one apart. Fetch the account first, then sync, then build.
 */
async function refreshBeforeAction(): Promise<PoolState> {
  const [{ decodePoolState }, { AccountId }, client] = await Promise.all([
    xykModule(),
    sdkModule(),
    getClient(),
  ])
  const account = await client.accounts.getOrImport(
    AccountId.fromHex(withHexPrefix(poolIdHex as string)),
  )
  await client.syncChain()
  currentState = decodePoolState(account)
  renderSummary()
  return currentState
}

async function doSwap(): Promise<void> {
  const sender = await senderAccountId()
  setBusy(swapSubmit, swapStatus, 'Submitting…')
  try {
    await syncWallet()
    await refreshBeforeAction()
    const state = currentState as PoolState
    const { AccountId } = await sdkModule()
    const tokenIn = AccountId.fromHex(withHexPrefix(swapSide.value))
    const side = state.token0FaucetId.toString() === swapSide.value ? 0 : 1
    const decimalsIn = side === 0 ? record!.token0Decimals : record!.token1Decimals
    const output = await (await poolHandle()).swap({
      sender,
      recipient: sender,
      tokenIn,
      amountIn: parseAmount(swapAmount.value, decimalsIn),
      slippageBps: slippageInput(swapSlippage),
      deadline: computeDeadline(),
    })
    const txId = await submitViaWallet(output.request)
    setText(swapStatus, `Submitted ${shortHex(txId)}; confirming…`)
    const { txHash } = await waitForTransaction(txId)
    toast(`Swap confirmed: ${shortHex(txHash)}`)
    setText(swapStatus, '')
    await loadState()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    setText(swapStatus, '')
  } finally {
    setBusy(swapSubmit, swapStatus, null)
  }
}

async function doAdd(): Promise<void> {
  const sender = await senderAccountId()
  setBusy(addSubmit, addStatus, 'Submitting…')
  try {
    await syncWallet()
    await refreshBeforeAction()
    const output = await (await poolHandle()).addLiquidity({
      sender,
      recipient: sender,
      amount0: parseAmount(addAmount0.value, record!.token0Decimals),
      amount1: parseAmount(addAmount1.value, record!.token1Decimals),
      slippageBps: slippageInput(addSlippage),
      deadline: computeDeadline(),
    })
    const txId = await submitViaWallet(output.request)
    setText(addStatus, `Submitted ${shortHex(txId)}; confirming…`)
    const { txHash } = await waitForTransaction(txId)
    toast(`Deposit confirmed: ${shortHex(txHash)}`)
    setText(addStatus, '')
    await loadState()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    setText(addStatus, '')
  } finally {
    setBusy(addSubmit, addStatus, null)
  }
}

async function doRemove(): Promise<void> {
  const sender = await senderAccountId()
  setBusy(removeSubmit, removeStatus, 'Submitting…')
  try {
    await syncWallet()
    await refreshBeforeAction()
    const output = await (await poolHandle()).removeLiquidity({
      sender,
      recipient: sender,
      amountLp: parseAmount(removeLp.value, 0),
      slippageBps: slippageInput(removeSlippage),
      deadline: computeDeadline(),
    })
    const txId = await submitViaWallet(output.request)
    setText(removeStatus, `Submitted ${shortHex(txId)}; confirming…`)
    const { txHash } = await waitForTransaction(txId)
    toast(`Withdrawal confirmed: ${shortHex(txHash)}`)
    setText(removeStatus, '')
    await loadState()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    setText(removeStatus, '')
  } finally {
    setBusy(removeSubmit, removeStatus, null)
  }
}

/** Reads the connected wallet's LP balance for this pool and fills the input. */

function setBusy(button: HTMLButtonElement, status: HTMLSpanElement, message: string | null): void {
  if (message !== null) {
    button.disabled = true
    setText(status, message)
  } else {
    renderWalletGating()
    setText(status, '')
  }
}

// Bootstrap runs last so every module-level const/let is initialized first
// (setupTabs/setupForms reference TABS and amountControls, declared below).
void boot()
