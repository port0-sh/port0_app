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

import { lpTokenSymbol, type Pool, type PoolConfig, type PoolState } from '@port0.sh/sdk'
import type { AccountId } from '@miden-sdk/miden-sdk'
import {
  getClient,
  getFreshAccount,
  getXyk,
  resetClient,
  sdkModule,
  xykModule,
  type XykModule,
} from '../lib/client'
import { CONFIG } from '../lib/config'
import { chainNetworkId } from '../lib/network'
import { clear, el, qs, setText } from '../lib/dom'
import {
  compactAmount,
  explorerAccountUrl,
  feeSplit,
  formatAmount,
  formatBps,
  formatRate,
  isHexId,
  normalizeHex,
  MAX_SLIPPAGE_BPS,
  parseAmount,
  parseSlippageBps,
  poolPageTitle,
  shortAddress,
  shortHex,
  withHexPrefix,
} from '../lib/format'
import { feeAprOneDay } from '../lib/fees'
import { fetchPool, fetchPoolHistory, toPoolView, type HistoryResolution, type IndexerPool, type IndexerSnapshot, type PoolView } from '../lib/indexer'
import { candles, formatScaled, priceScaled, sampleTime } from '../lib/history'
import { mountPriceChart, type ChartTheme, type PriceChart } from '../lib/chart'
import { mountSite } from '../lib/site'
import { playArrivalBell, primeSound } from '../lib/sound'
import { startSpinner } from '../ui/spinner'
import { mountTokenCombo, type TokenSource } from '../ui/tokenCombo'
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
mountSite()

const pageParams = new URLSearchParams(window.location.search)
/** Set by the launch flow, which is the only thing that knows a pool is new. */
const justCreated = pageParams.get('created') === '1'
const poolIdParam = pageParams.get('id')
const poolIdHex = poolIdParam ? normalizeHex(poolIdParam) : null

const pairTitle = qs<HTMLElement>(document, '#pool-pair')
const poolIdLine = qs<HTMLElement>(document, '#pool-id')
const poolError = qs<HTMLParagraphElement>(document, '#pool-error')
const statFee = qs<HTMLElement>(document, '#stat-fee')
const statVolume = qs<HTMLElement>(document, '#stat-volume')
const statApr = qs<HTMLElement>(document, '#stat-apr')
const poolLinks = qs<HTMLElement>(document, '#pool-links')
const poolReserves = qs<HTMLElement>(document, '#pool-reserves')
const poolLinksRow = qs<HTMLElement>(document, '#pool-links-row')

const swapForm = qs<HTMLFormElement>(document, '#swap-form')
const swapSide = qs<HTMLSelectElement>(document, '#swap-side')
const swapSideInput = qs<HTMLInputElement>(document, '#swap-side-input')
const swapAmount = qs<HTMLInputElement>(document, '#swap-amount')
const swapSlippage = qs<HTMLInputElement>(document, '#swap-slippage')
const swapQuote = qs<HTMLDivElement>(document, '#swap-quote')
const swapSubmit = qs<HTMLButtonElement>(document, '#swap-submit')
const swapStatus = qs<HTMLDivElement>(document, '#swap-status')

const addForm = qs<HTMLFormElement>(document, '#add-form')
const addAmount0 = qs<HTMLInputElement>(document, '#add-amount0')
const addAmount1 = qs<HTMLInputElement>(document, '#add-amount1')
const addSlippage = qs<HTMLInputElement>(document, '#add-slippage')
const addQuote = qs<HTMLDivElement>(document, '#add-quote')
const addSubmit = qs<HTMLButtonElement>(document, '#add-submit')
const addStatus = qs<HTMLDivElement>(document, '#add-status')

const removeForm = qs<HTMLFormElement>(document, '#remove-form')
const removeLp = qs<HTMLInputElement>(document, '#remove-lp')
const removeSlippage = qs<HTMLInputElement>(document, '#remove-slippage')
const removeQuote = qs<HTMLDivElement>(document, '#remove-quote')
const removeSubmit = qs<HTMLButtonElement>(document, '#remove-submit')
const removeStatus = qs<HTMLDivElement>(document, '#remove-status')
const poolGate = qs<HTMLParagraphElement>(document, '#pool-gate')
const poolStats = qs<HTMLElement>(document, '#pool-stats')
const poolBoot = qs<HTMLElement>(document, '#pool-boot')
const poolBootGlyph = qs<HTMLElement>(document, '#pool-boot-glyph')
const poolBootTitle = qs<HTMLElement>(document, '#pool-boot-title')
const poolBootDetail = qs<HTMLElement>(document, '#pool-boot-detail')
const priceNow = qs<HTMLElement>(document, '#price-now')
const priceNowValue = qs<HTMLElement>(document, '#price-now-value')
const priceNowReverse = qs<HTMLElement>(document, '#price-now-reverse')
const priceNowUnit = qs<HTMLElement>(document, '#price-now-unit')

const historyPanel = qs<HTMLElement>(document, '#history-panel')
const historyChart = qs<HTMLElement>(document, '#history-chart')
const historyNote = qs<HTMLElement>(document, '#history-note')
const historyTable = qs<HTMLTableElement>(document, '#history-table')
const historyRows = qs<HTMLElement>(document, '#history-rows')
const historyResolutionPicker = qs<HTMLElement>(document, '#history-resolution')
const historyReserve0Head = qs<HTMLElement>(document, '#history-reserve0-head')
const historyReserve1Head = qs<HTMLElement>(document, '#history-reserve1-head')

let record: PoolView | null = null
let indexedPool: IndexerPool | null = null
let currentState: PoolState | null = null

/** One indexer poll. The indexer samples every 15 s and polls the registry every 60 s. */
const POOL_POLL_MS = 5000
/** How long the page follows a confirmed action, and how often it re-reads state. */
const WATCH_MS = 60000
const WATCH_STEP_MS = 5000
/** How often the open page re-reads pool metadata and history. */
const HISTORY_REFRESH_MS = 60000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** The shared braille sweep, running in the boot glyph. */
let stopBoot: (() => void) | null = null

function startBootLoader(): void {
  stopBoot ??= startSpinner(poolBootGlyph)
}

function stopBootLoader(): void {
  stopBoot?.()
  stopBoot = null
}

/**
 * Resolves when the indexer serves the pool. A pool is absent between its
 * registration transaction and the indexer's next registry poll, so the page
 * waits and re-fetches instead of reporting an error. Only an unset pool id or
 * an unconfigured indexer URL is fatal.
 */
async function waitForPool(): Promise<PoolView | null> {
  poolBoot.hidden = false
  startBootLoader()
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      const indexed = await fetchPool(CONFIG.indexerUrl, poolIdHex as string)
      if (indexed) {
        const view = await toPoolView(indexed)
        indexedPool = indexed
        stopBootLoader()
        poolBoot.hidden = true
        return view
      }
      // A pool that exists but has not reached the indexer yet is a loading
      // state, not a missing one. Only the launch flow knows it just created a
      // pool, and it says so in the URL; everything else is a general wait.
      setText(poolBootTitle, justCreated ? 'Looking for this pool' : 'Loading pool')
      setText(
        poolBootDetail,
        justCreated
          ? attempt < 12
            ? 'New pools appear a few seconds after their creation transaction confirms.'
            : 'Still waiting. The indexer has not seen this pool yet; its registration ' +
              'may still be confirming.'
          : attempt < 12
            ? 'Reading this pool from the indexer and the chain.'
            : 'Still not visible. Check the pool id, or register the pool from the Launch page.',
      )
    } catch {
      setText(poolBootTitle, 'Pool data is unavailable')
      setText(poolBootDetail, 'The pool service cannot be reached. Trying again…')
    }
    await sleep(POOL_POLL_MS)
  }
}

async function boot(): Promise<void> {
  if (!poolIdHex) {
    showPoolError('No pool id in the URL. Use ?id=<pool account id>.')
    return
  }
  if (CONFIG.indexerUrl.length === 0) {
    showPoolError('Set VITE_INDEXER_URL to load pools.')
    return
  }
  const view = await waitForPool()
  if (!view) return
  record = view
  setText(pairTitle, `${record.token0Symbol} / ${record.token1Symbol}`)
  setText(poolIdLine, poolIdHex)
  poolIdLine.setAttribute('title', poolIdHex)
  poolStats.hidden = false
  renderIndexedPrice()
  renderPoolStats()
  void renderLinks()
  if (record.feeFaucetId.length === 0) {
    toast('Trading is disabled for this pool: it has no fee asset configured.', 'error', 12000)
  }
  setupTabs()
  setupForms()
  setupHistory()
  renderWalletGating()
  walletStore.subscribe(() => {
    renderWalletGating()
    void refreshBalances()
    // Connecting is what makes chain state useful, and it is the moment the
    // client may first be built.
    void loadState()
  })
  // The chart needs only indexer data, so it draws without the client.
  await loadHistory()
  await loadState()
  await refreshBalances()
  window.setInterval(() => {
    void refreshRecord().then(() => loadHistory())
    // Retry the chain read on the same cadence: a transient sync failure keeps
    // the last state, and the next tick recovers without a reload.
    void loadState()
  }, HISTORY_REFRESH_MS)
}

function showPoolError(message: string): void {
  poolError.hidden = false
  setText(poolError, message)
}

/**
 * Serializes chain reads. The WASM client is single-threaded, and two syncs in
 * flight throw; a post-action poll and a form submit can otherwise overlap.
 */
let chainReadQueue: Promise<unknown> = Promise.resolve()
function chainRead<T>(work: () => Promise<T>): Promise<T> {
  const run = chainReadQueue.then(work)
  chainReadQueue = run.catch(() => undefined)
  return run
}

/**
 * Why the chain read is unavailable, when it is.
 *
 * `null` means the last read succeeded or has not run. The two cases read
 * differently to a user: the client is a 21 MB WebAssembly module that a flaky
 * connection can fail to fetch, which is a reload, while a failed sync is
 * usually transient.
 */
let chainUnavailable: 'client' | 'state' | null = null

/** Builds the chain client, retrying a failed load before giving up. */
async function loadClient(): Promise<Awaited<ReturnType<typeof getClient>> | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getClient()
    } catch (error) {
      console.warn(`trading client load failed (attempt ${attempt + 1})`, error)
      // The memoised rejection would make every later call fail the same way.
      resetClient()
      if (attempt < 2) await sleep(1_000 * 2 ** attempt)
    }
  }
  return null
}

/** States the chain-read failure, but only to someone who can act on it. */
function reportChainUnavailable(): void {
  // A reader who has not connected a wallet does nothing on chain: the indexer
  // supplies the price, the reserves, and the history. Downloading the client
  // and reporting that it failed is noise, so the page stays quiet.
  if (!walletStore.get().connected) return
  if (currentState) return
  showPoolError(
    chainUnavailable === 'client'
      ? 'Could not load the trading client. Check your connection and reload.'
      : 'Pool state is unavailable right now. Reload to try again.',
  )
}

async function loadState(): Promise<void> {
  if (!poolIdHex) return
  // Nothing on the page needs the client until a wallet can act on chain.
  if (!walletStore.get().connected) return
  await chainRead(async () => {
    const client = await loadClient()
    if (!client) {
      chainUnavailable = 'client'
      console.error('trading client unavailable; pool state not read')
      reportChainUnavailable()
      return
    }
    try {
      const [{ decodePoolState }, { AccountId }] = await Promise.all([
        xykModule(),
        sdkModule(),
      ])
      // Sync first: the local store is a cache of chain state.
      await client.syncChain()
      // Force a chain fetch: the stored copy can lag, and the SDK's own
      // quote reads the store. Both must see the same account.
      const account = await getFreshAccount(AccountId.fromHex(withHexPrefix(poolIdHex)))
      currentState = decodePoolState(account)
      chainUnavailable = null
      poolError.hidden = true
      populateSwapSide()
      await recomputeQuotes()
      renderSummary()
    } catch (error) {
      // The detail is for the console; the page states the effect, not the cause.
      // A transient sync failure must not hide the state the page already has.
      console.error('pool state read failed', error)
      chainUnavailable = 'state'
      reportChainUnavailable()
    }
  })
}

function renderSummary(): void {
  if (!currentState || !record) return
  const state = currentState
  const removeLabel = document.querySelector('label[for="remove-lp"]')
  if (removeLabel) removeLabel.textContent = `LP tokens (${lpSymbol()})`
  const split = feeSplit(state.fees.lpFeeBps, state.fees.protocolFeeShareBps)
  setText(statFee, split.effective)
  // The swapper pays the LP fee tier; the protocol's cut is inside it, so the
  // three numbers are the tier, the cut, and what the LPs keep.
  statFee.title =
    `Effective fee ${split.effective}\n` +
    `Protocol cut ${split.share} of it, ${split.protocol}\n` +
    `LPs keep ${split.lpKeeps}`
  const reserves = { reserve0: state.reserve0.toString(), reserve1: state.reserve1.toString() }
  const price = spotPrice(reserves)
  renderPriceNow(reserves)
  renderReserves()
  // The tab names the pool, not the site, once the pool's own price is known.
  // Until then the page keeps the static title.
  document.title = poolPageTitle(
    CONFIG.brand.markText,
    price,
    record.token0Symbol,
    record.token1Symbol,
  )
}

/** The ratio of the two reserves, in token0 priced in token1. */
function spotPrice(state: { reserve0: string; reserve1: string }): string | null {
  if (!record) return null
  const scaled = priceScaled(state, record.token0Decimals, record.token1Decimals)
  return scaled === null ? null : formatScaled(scaled)
}

/**
 * Renders the headline price in both directions.
 *
 * The ratio, not the output of a one-token swap: on a thin pool those differ by
 * the price impact of a whole token, and the ratio is the number the indexer and
 * every quote start from.
 */
function renderPriceNow(state: { reserve0: string; reserve1: string } | null): void {
  if (!record) return
  const forward = state ? spotPrice(state) : null
  const reverse =
    state && record
      ? (() => {
          const scaled = priceScaled(
            { reserve0: state.reserve1, reserve1: state.reserve0 },
            record.token1Decimals,
            record.token0Decimals,
          )
          return scaled === null ? null : formatScaled(scaled)
        })()
      : null
  priceNowValue.textContent = forward ?? '—'
  priceNowUnit.textContent =
    forward === null
      ? 'No liquidity yet'
      : `1 ${record.token0Symbol} = ${forward} ${record.token1Symbol}`
  priceNowReverse.textContent =
    reverse === null ? '' : `1 ${record.token1Symbol} = ${reverse} ${record.token0Symbol}`
  priceNow.hidden = false
}

/**
 * Fills the headline from the indexer before the first chain read lands. The
 * chain state supersedes it: the indexer samples every 15 s, so its reserves are
 * the older of the two.
 */
function renderIndexedPrice(): void {
  if (currentState !== null || !record || !indexedPool) return
  renderPriceNow({ reserve0: indexedPool.reserve0, reserve1: indexedPool.reserve1 })
}

/**
 * Renders the figures the indexer derives from its activity ring: the fee yield
 * for liquidity providers and the fees they earned. Both cover 24 h, or the
 * pool's age while it is younger, so the yield carries its basis.
 */
function renderPoolStats(): void {
  const pool = indexedPool
  const view = record
  if (!pool || !view) return
  setText(
    statApr,
    pool.fee_apr_window_secs > 0
      ? `${formatRate(feeAprOneDay(pool.fee_apr, pool.fee_apr_window_secs))} · 24h`
      : '—',
  )
  // One line per side: on one line the pair wraps and the second amount is lost.
  setText(statVolume, '')
  statVolume.append(
    el(
      'span',
      { class: 'figure-line' },
      `${compactAmount(BigInt(pool.volume_24h_0), view.token0Decimals)} ${view.token0Symbol}`,
    ),
    el(
      'span',
      { class: 'figure-line' },
      `${compactAmount(BigInt(pool.volume_24h_1), view.token1Decimals)} ${view.token1Symbol}`,
    ),
  )
  renderReserves()
}

/** The bech32 form of an account id, which is what an explorer link takes. */
async function bech32(id: string): Promise<string> {
  const { AccountId, AccountInterface } = await sdkModule()
  return AccountId.fromHex(withHexPrefix(id)).toBech32(
    await chainNetworkId(),
    AccountInterface.BasicWallet,
  )
}

/** A 16x16 line icon, built in the SVG namespace so it renders. */
function icon(pathData: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', pathData)
  svg.append(path)
  return svg
}

const COPY_ICON = 'M6 5.5h6.5V14H6zM3.5 10.5v-8h6.5'
const EXTERNAL_ICON = 'M7 3.5h5.5V9M12.5 3.5 5 11'

/**
 * Copies an address.
 *
 * The clipboard is a permission and a user gesture, so a refusal is reported
 * rather than passed off as a copy.
 */
async function copyAddress(id: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(withHexPrefix(id))
    toast(`${label} address copied.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toast(`Could not copy the ${label} address: ${message}`, 'error')
  }
}

/** One linked account: label, shortened id, copy button, and explorer link. */
function linkRow(label: string, id: string, url: string | null): HTMLElement {
  const row = el(
    'div',
    { class: 'link-row' },
    el('span', { class: 'link-label' }, label),
    el('span', { class: 'mono link-id' }, shortAddress(id)),
  )
  row.append(
    el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Copy the ${label} address`,
        title: `Copy the ${label} address`,
        onclick: () => void copyAddress(id, label),
      },
      icon(COPY_ICON),
    ),
  )
  if (url !== null) {
    row.append(
      el(
        'a',
        {
          class: 'icon-btn',
          href: url,
          target: '_blank',
          rel: 'noopener',
          'aria-label': `Open the ${label} address in the explorer`,
          title: `Open the ${label} address in the explorer`,
        },
        icon(EXTERNAL_ICON),
      ),
    )
  }
  return row
}

/** Rows for the pool and for both of its faucets. */
async function renderLinks(): Promise<void> {
  if (!record || poolIdHex === null) return
  const [poolUrl, token0Url, token1Url] = await Promise.all([
    explorerAccountUrl(CONFIG.explorerUrl, await bech32(poolIdHex)),
    explorerAccountUrl(CONFIG.explorerUrl, await bech32(record.token0FaucetId)),
    explorerAccountUrl(CONFIG.explorerUrl, await bech32(record.token1FaucetId)),
  ])
  for (const row of poolLinksRow.querySelectorAll('.link-row')) row.remove()
  poolLinksRow.append(
    linkRow('Pool', poolIdHex, poolUrl),
    linkRow(record.token0Symbol, record.token0FaucetId, token0Url),
    linkRow(record.token1Symbol, record.token1FaucetId, token1Url),
  )
  poolLinks.hidden = false
}

/** The pool's reserves, from the chain state when it has landed, else the indexer. */
function renderReserves(): void {
  if (!record) return
  const reserve0 =
    currentState?.reserve0 ?? (indexedPool ? BigInt(indexedPool.reserve0) : null)
  const reserve1 =
    currentState?.reserve1 ?? (indexedPool ? BigInt(indexedPool.reserve1) : null)
  if (reserve0 === null || reserve1 === null) return
  setText(
    poolReserves,
    `Reserves: ${formatAmount(reserve0, record.token0Decimals)} ${record.token0Symbol} · ` +
      `${formatAmount(reserve1, record.token1Decimals)} ${record.token1Symbol}`,
  )
}

/** Re-reads the pool metadata from the indexer; keeps the last view on error. */
async function refreshRecord(): Promise<void> {
  if (!poolIdHex) return
  try {
    const pool = await fetchPool(CONFIG.indexerUrl, poolIdHex)
    if (pool) {
      indexedPool = pool
      record = await toPoolView(pool)
      renderIndexedPrice()
      renderPoolStats()
    }
  } catch {
    // The indexer is the pool source; a failed poll leaves the last view in place.
  }
}

/**
 * Follows a confirmed action until the pool state moves, for up to WATCH_MS.
 * The wallet confirms at its own block, the pool account changes in the next
 * block, and the indexer samples within its 15 s poll, so a single read after
 * the transaction returns stale reserves.
 */
function watchUntilChanged(before: PoolState, status: HTMLSpanElement): void {
  const deadline = Date.now() + WATCH_MS
  const step = async (): Promise<void> => {
    await loadState()
    await refreshBalances()
    await refreshRecord()
    await loadHistory()
    const moved =
      currentState !== null &&
      (currentState.reserve0 !== before.reserve0 ||
        currentState.reserve1 !== before.reserve1 ||
        currentState.lpSupply !== before.lpSupply)
    if (moved) {
      setText(status, '')
      return
    }
    if (Date.now() >= deadline) {
      setText(status, 'The pool has not changed yet. Reload to check again.')
      return
    }
    setText(status, 'Updating…')
    await sleep(WATCH_STEP_MS)
    void step()
  }
  void step()
}

/* Pool history: a lightweight-charts price series plus a sample table. */

/** Table rows, newest first. */
const HISTORY_ROWS = 24

let historyResolution: HistoryResolution = '1m'
let chartPromise: Promise<PriceChart> | null = null

/** Reads a stylesheet colour, so the chart matches the palette exactly. */
function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

function chartTheme(): ChartTheme {
  return {
    background: cssColor('--black', '#000000'),
    text: cssColor('--light-grey', '#a8b6b1'),
    grid: cssColor('--dark-grey', '#5f574f'),
    up: cssColor('--green', '#00f239'),
    down: cssColor('--error', '#f200b9'),
  }
}

/** The chart library loads on first use; only this page draws a chart. */
function ensureChart(): Promise<PriceChart> {
  chartPromise ??= mountPriceChart(historyChart, chartTheme())
  return chartPromise
}

function setupHistory(): void {
  historyPanel.hidden = false
  setText(historyReserve0Head, record?.token0Symbol ?? 'Token 0')
  setText(historyReserve1Head, record?.token1Symbol ?? 'Token 1')
  historyResolutionPicker.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-resolution]',
    )
    const resolution = button?.dataset.resolution as HistoryResolution | undefined
    if (!button || !resolution || resolution === historyResolution) return
    historyResolution = resolution
    for (const chip of historyResolutionPicker.querySelectorAll('button')) {
      chip.classList.toggle('is-active', chip === button)
    }
    void loadHistory()
  })
}

async function loadHistory(): Promise<void> {
  if (!poolIdHex) return
  try {
    const samples = await fetchPoolHistory(CONFIG.indexerUrl, poolIdHex, historyResolution)
    await renderHistory(samples)
  } catch {
    historyNote.hidden = false
    setText(historyNote, 'Price history is unavailable right now.')
  }
}

/** Sample time as HH:MM, or MM-DD HH:MM at hourly resolution. */
function formatSampleTime(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  // The long windows span days, so their labels carry the date.
  if (historyResolution === '1d') {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${month}-${day}`
  }
  if (historyResolution === '1h' || historyResolution === '6h') {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${month}-${day} ${hours}:${minutes}`
  }
  return `${hours}:${minutes}`
}

async function renderHistory(samples: IndexerSnapshot[]): Promise<void> {
  renderHistoryTable(samples)
  const view = record
  const series =
    view === null ? [] : candles(samples, view.token0Decimals, view.token1Decimals)

  const chart = await ensureChart()
  chart.setData(series)
  const empty = series.length === 0
  historyChart.hidden = empty
  historyNote.hidden = !empty
  if (empty) setText(historyNote, 'No price history yet.')
}

/**
 * The samples where the pool changed.
 *
 * The indexer writes a point every poll so the chart's last bucket advances,
 * and an idle pool's points all carry the time of its last change. As rows they
 * would repeat one timestamp, so the table lists changes and the chart keeps
 * every bucket.
 */
function historyChanges(samples: IndexerSnapshot[]): IndexerSnapshot[] {
  const changes: IndexerSnapshot[] = []
  for (const sample of samples) {
    const previous = changes[changes.length - 1]
    const unchanged =
      previous !== undefined &&
      previous.reserve0 === sample.reserve0 &&
      previous.reserve1 === sample.reserve1 &&
      previous.lp_supply === sample.lp_supply
    if (!unchanged) changes.push(sample)
  }
  return changes
}

function renderHistoryTable(samples: IndexerSnapshot[]): void {
  clear(historyRows)
  const view = record
  const changes = historyChanges(samples)
  if (changes.length === 0 || !view) {
    historyTable.hidden = true
    return
  }
  historyTable.hidden = false
  for (const sample of changes.slice(-HISTORY_ROWS).reverse()) {
    const scaled = priceScaled(sample, view.token0Decimals, view.token1Decimals)
    const row = el('tr')
    row.append(
      el('td', { class: 'mono' }, formatSampleTime(sampleTime(sample))),
      el('td', { class: 'mono' }, String(sample.block)),
      el('td', { class: 'mono' }, scaled === null ? '—' : formatScaled(scaled)),
      el('td', { class: 'mono' }, formatAmount(BigInt(sample.reserve0), view.token0Decimals)),
      el('td', { class: 'mono' }, formatAmount(BigInt(sample.reserve1), view.token1Decimals)),
      el('td', { class: 'mono' }, formatAmount(BigInt(sample.lp_supply), 0)),
    )
    historyRows.append(row)
  }
}


/** The port0 module, if already loaded. Null when quotes have never run. */
let loadedXykModule: XykModule | null = null

function trimFraction(value: string, maxFractionDigits = 6): string {
  const [intPart, frac = ''] = value.split('.')
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, '')
  return trimmed ? `${intPart}.${trimmed}` : intPart
}

function populateSwapSide(): void {
  if (!currentState || !record) return
  // Option values must be the ids the autocomplete's source uses, or choosing
  // from the dropdown sets the select to a value no option has, which clears
  // it. Both sides are `normalizeHex` ids.
  const token0 = normalizeHex(currentState.token0FaucetId.toString())
  const token1 = normalizeHex(currentState.token1FaucetId.toString())
  // Rebuilding the options would reset the browser's selection to the first
  // side on every state refresh, including the poll after a confirmed swap.
  const selected = swapSide.value
  clear(swapSide)
  swapSide.append(
    el('option', { value: '' }, 'Select token'),
    el('option', { value: token0 }, record.token0Symbol),
    el('option', { value: token1 }, record.token1Symbol),
  )
  const kept = [...swapSide.options].some((option) => option.value === selected) ? selected : ''
  // Default to token0 -> token1, so the form quotes as soon as an amount is
  // typed. Choosing token1 swaps the other way.
  swapSide.value = kept || token0
  swapSideCombo.refresh()
  if (swapSide.value !== selected) renderBalanceLines()
}

/** The pool's two tokens, as the shared token autocomplete wants them. */
function swapSideSource(): TokenSource {
  if (!currentState || !record) {
    return { entries: [], emptyNote: 'Loading the pool…' }
  }
  return {
    entries: [
      [
        normalizeHex(currentState.token0FaucetId.toString()),
        { symbol: record.token0Symbol, decimals: record.token0Decimals },
      ],
      [
        normalizeHex(currentState.token1FaucetId.toString()),
        { symbol: record.token1Symbol, decimals: record.token1Decimals },
      ],
    ],
  }
}

const swapSideCombo = mountTokenCombo(
  swapSideInput,
  swapSide,
  swapSideSource,
  (id) => {
    if (!record) return shortHex(id)
    return normalizeHex(record.token0FaucetId.toString()) === normalizeHex(id)
      ? record.token0Symbol
      : record.token1Symbol
  },
  () => {
    renderSwapQuote()
    renderBalanceLines()
  },
)

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
    () => lpSymbol(),
    () => 0,
  )
}

/**
 * The LP token's symbol, as the pool account's faucet metadata names it. The
 * pool is its own LP faucet, so a wallet and this page agree on the name.
 */
function lpSymbol(): string {
  if (!record?.token0Symbol || !record?.token1Symbol) return 'LP'
  try {
    return lpTokenSymbol(record.token0Symbol, record.token1Symbol)
  } catch {
    // A token symbol without an A-Z letter cannot derive one; the account has
    // the same fallback.
    return 'LP'
  }
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
  if (!currentState) return 1
  return normalizeHex(currentState.token0FaucetId.toString()) === normalizeHex(swapSide.value)
    ? 0
    : 1
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
      const hex = isHexId(raw)
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
  return parseSlippageBps(input.value)
}

// The fields carry the same ceiling the parser enforces, so the browser refuses
// the value before it reaches the quote.
for (const input of [swapSlippage, addSlippage, removeSlippage]) {
  input.max = String(MAX_SLIPPAGE_BPS)
}

function renderSwapQuote(): void {
  clear(swapQuote)
  if (!currentState || !record || !loadedXykModule) return
  if (!swapSide.value) {
    swapQuote.append(el('p', { class: 'muted' }, 'Pick a token to see the quote.'))
    return
  }
  const { amountOut, applySlippage } = loadedXykModule
  const state = currentState
  const side = currentSide()
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
      state.fees.protocolFeeShareBps,
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
    if (slippageBps > 100n) {
      lines.push(
        el(
          'p',
          { class: 'error' },
          `Slippage ${formatBps(slippageBps)}: the pool may fill you up to that far from the quote.`,
        ),
      )
    }
    swapQuote.append(...lines)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/amount out is zero/i.test(message)) {
      const minIn = minInputForOneOut(reserveIn, reserveOut, state.fees.lpFeeBps)
      swapQuote.append(
        quoteError(
          `Amount out rounds to zero at this pool's ratio. The smallest swap that pays 1 base unit is about ${formatAmount(minIn, decimalsIn)} ${symbolIn}.`,
        ),
      )
    } else {
      swapQuote.append(quoteError(message))
    }
  }
}

/**
 * Smallest input whose swap pays at least one base unit of output.
 *
 * Solves `in_with_fee * out / (reserve_in * 10000 + in_with_fee) >= 1` for the
 * input, with `in_with_fee = in * (10000 - lp_fee_bps)`. Zero when the pool is
 * too shallow for any amount to pay a base unit.
 */
function minInputForOneOut(
  reserveIn: bigint,
  reserveOut: bigint,
  lpFeeBps: bigint,
): bigint {
  if (reserveOut <= 1n || lpFeeBps >= 10_000n) return 0n
  const numerator = reserveIn * 10_000n
  const denominator = (reserveOut - 1n) * (10_000n - lpFeeBps)
  return (numerator + denominator - 1n) / denominator
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
      el('p', {}, `${lpSymbol()} you receive: ${quote.liquidityToUser.toString()}`),
      el(
        'p',
        {},
        `Minimum ${lpSymbol()} (slippage ${slippageBps} bps): ${minLp.toString()}`,
      ),
    ]
    if (state.lpSupply === 0n) {
      lines.push(
        el(
          'p',
          { class: 'muted' },
          'This is the first deposit, so it sets the pool price. A very imbalanced deposit makes small swaps round to zero.',
        ),
      )
    }
    lines.push(
      el(
        'p',
        { class: 'muted' },
        'Depositing is not holding: if the price moves, the pool rebalances towards the new ratio you can withdraw, ' +
          'so the two amounts you take out may be worth less than the two you put in. Fees earned are what offset that.',
      ),
    )
    // The share of the pool this deposit buys, so a creator sees what they own.
    const totalAfter = state.lpSupply + quote.liquidityToUser
    const shareBps = totalAfter > 0n ? (quote.liquidityToUser * 10000n) / totalAfter : 0n
    lines.push(el('p', { class: 'muted' }, `Your share of the pool after this deposit: ${formatBps(shareBps)}`))
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
    removeQuote.append(
      el('p', { class: 'muted' }, `Enter a ${lpSymbol()} amount to see the quote.`),
    )
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
  const hasFees = (record?.feeFaucetId ?? '').length > 0
  const enabled = connected && hasFees

  for (const button of [swapSubmit, addSubmit, removeSubmit]) {
    button.disabled = !enabled
    button.textContent = enabled
      ? 'Submit'
      : connected
        ? 'Trading disabled'
        : 'Connect wallet to act'
  }

  // One gate line above the tabs. Shown only when an action is blocked:
  // not connected, or the pool has no fee faucet and cannot price notes.
  const gate = !connected
    ? 'Login to act on this pool.'
    : !hasFees
      ? 'Trading is disabled for this pool: it was imported without its fee faucet id.'
      : ''
  poolGate.hidden = gate === ''
  setText(poolGate, gate)
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
function refreshBeforeAction(): Promise<PoolState> {
  return chainRead(async () => {
    const [{ decodePoolState }, { AccountId }, client] = await Promise.all([
      xykModule(),
      sdkModule(),
      getClient(),
    ])
    const account = await getFreshAccount(AccountId.fromHex(withHexPrefix(poolIdHex as string)))
    await client.syncChain()
    currentState = decodePoolState(account)
    renderSummary()
    return currentState
  })
}

async function doSwap(): Promise<void> {
  if (!swapSide.value) {
    toast('Pick the token to pay.', 'error')
    return
  }
  primeSound()
  const sender = await senderAccountId()
  setBusy(swapSubmit, swapStatus, 'Submitting…')
  try {
    await syncWallet()
    const before = await refreshBeforeAction()
    const { AccountId } = await sdkModule()
    const tokenIn = AccountId.fromHex(withHexPrefix(swapSide.value))
    const side = currentSide()
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
    playArrivalBell()
    toast(`Swap confirmed: ${shortHex(txHash)}`)
    watchUntilChanged(before, swapStatus)
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
    const before = await refreshBeforeAction()
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
    watchUntilChanged(before, addStatus)
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
    const before = await refreshBeforeAction()
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
    watchUntilChanged(before, removeStatus)
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
