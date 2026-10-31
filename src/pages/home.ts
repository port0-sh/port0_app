/**
 * Home page: pool browsing.
 *
 * The pool list is the indexer's, which reads the on-chain registry. There is no
 * local pool list and no manual import. Prices and amounts are computed from the
 * indexer's reserves with the same exact bigint arithmetic the pool page uses,
 * so the Miden SDK is not loaded on this page at all.
 */

import { CONFIG } from '../lib/config'
import { getPublicAccount, sdkModule } from '../lib/client'
import { clear, el, qs, setText, type Child } from '../lib/dom'
import { feeAprOneDay } from '../lib/fees'
import { feeAssetTotals, volumeValuer, type PoolVolume } from '../lib/stats'
import {
  compactAmount,
  formatAmount,
  formatBps,
  formatRate,
  isHexId,
  normalizeHex,
  parseAmount,
  parseSlippagePercent,
  shortAddress,
  shortHex,
} from '../lib/format'
import { formatScaled, priceScaled } from '../lib/history'
import {
  fetchLegacyPools,
  fetchPools,
  fetchStatus,
  toPoolView,
  type IndexerPool,
  type IndexerStatus,
  type PoolView,
} from '../lib/indexer'
import {
  executeRoute,
  HopFailure,
  type RouteProgress,
  type RouteResult,
} from '../lib/multihop'
import {
  findRoutes,
  minInputForOneOut,
  reachableTokens,
  routerPools,
  routeTokens,
  type Route,
} from '../lib/router'
import { listedPools } from '../lib/registry'
import { mountSite } from '../lib/site'
import { playArrivalBell, primeSound } from '../lib/sound'
import { mountTokenCombo, type TokenEntry, type TokenSource } from '../ui/tokenCombo'
import { adoptLoader, startSpinner } from '../ui/spinner'
import { toast } from '../ui/toast'
import { mountWallet } from '../wallet/ui'
import { requestAssets, syncWallet, walletStore } from '../wallet/wallet'

mountWallet()
mountSite()

const tableHost = qs<HTMLDivElement>(document, '#pool-table')
const filterInput = qs<HTMLInputElement>(document, '#pool-filter')
const pagePrev = qs<HTMLButtonElement>(document, '#page-prev')
const pageNext = qs<HTMLButtonElement>(document, '#page-next')
const pageStatus = qs<HTMLSpanElement>(document, '#page-status')
const pageSizeSelect = qs<HTMLSelectElement>(document, '#page-size')
const poolCount = qs<HTMLElement>(document, '#pool-count')
const tableLoader = qs<HTMLElement>(document, '#table-loader')
/** The mounted table loader, while a read is running. */
let stopLoader: (() => void) | null = null
const showLegacyInput = qs<HTMLInputElement>(document, '#show-legacy')
// On by default: the indexer serves the legacy rows, so showing them costs one
// request. The toggle hides them without unloading their views.
let showLegacy = localStorage.getItem('port0-app:show-legacy:v1') !== '0'
showLegacyInput.checked = showLegacy
showLegacyInput.addEventListener('change', () => {
  showLegacy = showLegacyInput.checked
  localStorage.setItem('port0-app:show-legacy:v1', showLegacy ? '1' : '0')
  if (showLegacy) void loadLegacyPools()
  renderTable()
})
const refreshButton = qs<HTMLButtonElement>(document, '#refresh-states')
const refreshStatus = qs<HTMLSpanElement>(document, '#refresh-status')
const routeForm = qs<HTMLFormElement>(document, '#route-form')
const routeTokenIn = qs<HTMLSelectElement>(document, '#route-token-in')
const routeTokenOut = qs<HTMLSelectElement>(document, '#route-token-out')
const routeAmount = qs<HTMLInputElement>(document, '#route-amount')
const routeSlippage = qs<HTMLInputElement>(document, '#route-slippage')
const routeQuote = qs<HTMLDivElement>(document, '#route-quote')
const routeSubmit = qs<HTMLButtonElement>(document, '#route-submit')
const swapPaused = qs<HTMLParagraphElement>(document, '#swap-paused')
swapPaused.hidden = CONFIG.tradingEnabled
const routeStatus = qs<HTMLDivElement>(document, '#route-status')
const routeAmountOut = qs<HTMLInputElement>(document, '#route-amount-out')
const routeMinOut = qs<HTMLSpanElement>(document, '#route-min-out')
const routeBalanceIn = qs<HTMLSpanElement>(document, '#route-balance-in')
const routePercents = qs<HTMLSpanElement>(document, '#route-percents')
const statTvl = qs<HTMLSpanElement>(document, '#stat-tvl')
const statVolume = qs<HTMLSpanElement>(document, '#stat-volume')
const statPools = qs<HTMLSpanElement>(document, '#stat-pools')
const statSwaps = qs<HTMLSpanElement>(document, '#stat-swaps')
const statApr = qs<HTMLSpanElement>(document, '#stat-apr')
const statFooter = qs<HTMLParagraphElement>(document, '#stat-footer')
const swapCard = qs<HTMLElement>(document, '#swap-card')
const statsPanel = qs<HTMLElement>(document, '#protocol-stats')
const swapHero = qs<HTMLElement>(document, '.swap-hero')
const routeTokenInInput = qs<HTMLInputElement>(document, '#route-token-in-input')
const routeTokenOutInput = qs<HTMLInputElement>(document, '#route-token-out-input')
const routeSettingsToggle = qs<HTMLButtonElement>(document, '#route-settings-toggle')
const routeSettings = qs<HTMLDivElement>(document, '#route-settings')
const routeFlip = qs<HTMLButtonElement>(document, '#route-flip')

/**
 * Poll interval for the always-on list. Miden testnet produces a block about
 * every 3s; 15s is five blocks, so a swap or deposit appears within that.
 */
const REFRESH_INTERVAL_MS = 15_000

/** Every indexed pool: the table and the router both read this one set. */
type TablePool = IndexerPool & { legacy?: boolean; seedOnly?: boolean }
let allPools: TablePool[] = []
/** The indexer's active registry, replaced on every poll. */
let activePoolsList: TablePool[] = []
/** Legacy rows, loaded once; kept across polls so they do not blink. */
let legacyPools: TablePool[] = []
let legacyViews = new Map<string, PoolView>()
let legacyLoaded = false
let legacyLoading = false
let views = new Map<string, PoolView>()
let refreshing = false
let firstRefreshDone = false
/** The route the quote panel is showing, or null. */
let routeBest: Route | null = null
/** Token metadata read from the faucet accounts, keyed by lowercase faucet id. */
const verifiedMeta = new Map<string, TokenEntry>()
/** The route whose pools and tokens were verified on chain. */
let verifiedRouteKey = ''
let routeVerified = false
let verifyingRoute = false
/** A key that failed verification; not retried until the route changes. */
let failedRouteKey = ''
/** A route stopped at a hop, kept so Retry resumes instead of starting over. */
let pendingRoute: {
  route: Route
  nextHop: number
  amountIn: bigint
  balanceBefore: bigint
  stage: 'submit' | 'consume'
} | null = null

/**
 * Tokens the connected wallet holds that are also tradable in our pools. Null
 * means not loaded; `walletTokensState` separates "not connected" from
 * "loading" so the pay side can say which.
 */
let walletTokens: Array<[string, TokenEntry]> | null = null
let walletTokensState: 'idle' | 'loading' | 'ready' = 'idle'
/** True while a wallet-token refresh runs; the store can churn faster than that. */
let walletTokensInFlight = false
/** The connected address the token list was loaded for. */
let walletTokensFor: string | null = null
/** The indexer's last status, for the stats footer. */
let indexerStatus: IndexerStatus | null = null

/** Rows per page. Options are the page-size control's; 10 is the default. */
let pageSize = 10
let pageIndex = 0

/** Table sort. Daily volume descending by default, the busiest pools first. */
type SortKey = 'pair' | 'volume' | 'fee' | 'apr'
let sortKey: SortKey = 'volume'
let sortDir: 'asc' | 'desc' = 'desc'

try {
  const stored = Number(localStorage.getItem('port0-app:page-size'))
  if ([10, 25, 50].includes(stored)) pageSize = stored
} catch {
  // Storage unavailable: the default stands.
}
pageSizeSelect.value = String(pageSize)

let routeRunning = false
/** A hop may still land; the route stays blocked until a reload. */
let routeHeld = false

refreshButton.addEventListener('click', () => {
  void refresh({ manual: true })
})

/** The refresh control is the table's one progress indicator. */
let stopRefreshSpinner: (() => void) | null = null
function setRefreshBusy(busy: boolean): void {
  if (busy) {
    if (stopRefreshSpinner !== null) return
    refreshButton.disabled = true
    refreshButton.textContent = ''
    stopRefreshSpinner = startSpinner(refreshButton)
  } else {
    stopRefreshSpinner?.()
    stopRefreshSpinner = null
    refreshButton.disabled = false
    refreshButton.textContent = 'Refresh'
  }
}

pagePrev.addEventListener('click', () => {
  if (pageIndex > 0) {
    pageIndex -= 1
    renderTable()
  }
})

pageNext.addEventListener('click', () => {
  pageIndex += 1
  renderTable()
})

pageSizeSelect.addEventListener('change', () => {
  pageSize = Number(pageSizeSelect.value) || 10
  pageIndex = 0
  try {
    localStorage.setItem('port0-app:page-size', String(pageSize))
  } catch {
    // Storage unavailable: the page size lasts for the session.
  }
  renderTable()
})

// Filter on every keystroke, debounced. The filter is client-side over the
// loaded pool set, so it matches symbols and ids alike.
let filterTimer: number | null = null
filterInput.addEventListener('input', () => {
  if (filterTimer !== null) window.clearTimeout(filterTimer)
  filterTimer = window.setTimeout(() => {
    filterTimer = null
    pageIndex = 0
    renderTable()
  }, 120)
})

renderTable()

/**
 * Loads every indexed pool, up to a five-page safety cap, and rebuilds both the
 * table and the router's token set. The client filters, sorts, and pages the
 * set, so neither a symbol filter nor a sort needs another request.
 */
async function refresh(options: { manual?: boolean } = {}): Promise<void> {
  if (refreshing) return
  if (CONFIG.indexerUrl.length === 0) {
    adoptLoader(tableLoader)?.()
    renderTable()
    return
  }
  refreshing = true
  // The loader fills the table area only when there is no table: the first read,
  // or a later one with nothing on screen. A refresh with rows leaves them where
  // they are; the button's spinner says the read is running.
  const showLoader = allPools.length === 0
  stopLoader?.()
  if (showLoader) {
    clear(tableHost)
    stopLoader = adoptLoader(tableLoader)
  } else {
    stopLoader = null
  }
  try {
    const collected: IndexerPool[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page += 1) {
      const result = await fetchPools(CONFIG.indexerUrl, { cursor, limit: 200 })
      collected.push(...result.pools)
      cursor = result.nextCursor
      if (cursor === null) break
    }
    const resolved = new Map<string, PoolView>()
    for (const pool of collected) {
      // The list shows symbols and reserves, not note fees, so the WASM SDK
      // stays out of this page's dependency graph.
      resolved.set(pool.id.toLowerCase(), await toPoolView(pool, false))
    }
    activePoolsList = collected.map((pool) => ({
      ...pool,
      seedOnly: BigInt(pool.lp_supply) <= 1000n,
    }))
    views = resolved
    // The poll replaces the active list; legacy rows and their views survive it.
    for (const [id, view] of legacyViews) views.set(id, view)
    allPools = [...activePoolsList, ...legacyPools]
    // The first read has landed: renderTable may draw now. Setting this before
    // the render, not in `finally`, because the render is what finishes the
    // loading state.
    firstRefreshDone = true
    renderRouteTokens()
    renderRouteQuote()
    renderTable()
    indexerStatus = await fetchStatus(CONFIG.indexerUrl)
    renderStats()
    // Legacy rows load only when the reader turns them on, or on a manual
    // refresh once they are on.
    if (showLegacy) void loadLegacyPools(options.manual === true)
    setText(refreshStatus, `updated ${new Date().toLocaleTimeString()}`)
  } catch (error) {
    // A partial list must not look like a complete one.
    console.error('[indexer] pool list failed', error)
    if (options.manual) {
      toast(error instanceof Error ? error.message : 'Pool list is unavailable.', 'error')
      setText(refreshStatus, '')
    }
  } finally {
    refreshing = false
    firstRefreshDone = true
    stopLoader?.()
    stopLoader = null
  }
}

/**
 * Appends the legacy registries' pools to the same list as the active ones. They
 * carry `legacy: true`: the table dims them and tags them, the router and the
 * stats ignore them.
 *
 * The rows come from the indexer, which read the pools once at startup. Reading
 * the same accounts in the browser imports them, one per pool and faucet, and
 * each import blocks the main thread; the list is a snapshot either way.
 */
async function loadLegacyPools(force = false): Promise<void> {
  if (CONFIG.legacyRegistryIds.length === 0 || legacyLoading) return
  if (legacyLoaded && !force) return
  legacyLoading = true
  setRefreshBusy(true)
  try {
    const wanted = new Set(CONFIG.legacyRegistryIds.map(normalizeHex))
    const loaded = await fetchLegacyPools(CONFIG.indexerUrl)
    const extra: TablePool[] = []
    const extraViews = new Map<string, PoolView>()
    for (const pool of loaded) {
      if (!wanted.has(normalizeHex(pool.registry_id))) continue
      if (activePoolsList.some((active) => active.id.toLowerCase() === pool.id.toLowerCase())) {
        continue
      }
      extra.push({
        id: pool.id,
        token0: pool.token0,
        token1: pool.token1,
        token0_symbol: pool.token0_symbol,
        token0_decimals: pool.token0_decimals,
        token1_symbol: pool.token1_symbol,
        token1_decimals: pool.token1_decimals,
        fee_asset_id: CONFIG.chainFeeFaucetId,
        reserve0: pool.reserve0,
        reserve1: pool.reserve1,
        lp_supply: pool.lp_supply,
        k: (BigInt(pool.reserve0) * BigInt(pool.reserve1)).toString(),
        spot_price: 0,
        pot0: '0',
        pot1: '0',
        lp_fee_bps: pool.lp_fee_bps,
        protocol_fee_share_bps: pool.protocol_fee_share_bps,
        block: 0,
        first_seen_unix: 0,
        last_change_unix: 0,
        volume_24h_0: '0',
        volume_24h_1: '0',
        lp_fees_24h_0: '0',
        lp_fees_24h_1: '0',
        protocol_fees_24h_0: '0',
        protocol_fees_24h_1: '0',
        swaps_24h: 0,
        adds_24h: 0,
        removes_24h: 0,
        collects_24h: 0,
        fee_apr: 0,
        fee_apr_window_secs: 0,
        legacy: true,
        seedOnly: BigInt(pool.lp_supply) <= 1000n,
      })
      extraViews.set(pool.id.toLowerCase(), {
        poolId: pool.id,
        token0FaucetId: normalizeHex(pool.token0),
        token1FaucetId: normalizeHex(pool.token1),
        token0Symbol: pool.token0_symbol,
        token1Symbol: pool.token1_symbol,
        token0Decimals: pool.token0_decimals,
        token1Decimals: pool.token1_decimals,
        feeFaucetId: CONFIG.chainFeeFaucetId,
        noteFees: {},
      })
    }
    legacyPools = extra
    legacyViews = extraViews
    legacyLoaded = true
    allPools = [...activePoolsList, ...legacyPools]
    for (const [id, view] of legacyViews) views.set(id, view)
    renderTable()
    renderStats()
  } catch (error) {
    console.error('[legacy] pool load failed', error)
  } finally {
    legacyLoading = false
    setRefreshBusy(false)
  }
}

function renderTable(): void {
  // Before the first read completes there is no pool set to render: the loader
  // host carries that state, and an empty table would read as "no pools".
  if (!firstRefreshDone) return
  clear(tableHost)

  if (CONFIG.indexerUrl.length === 0) {
    setText(poolCount, '')
    tableHost.append(
      el('p', { class: 'muted' }, 'Set VITE_INDEXER_URL to list pools. The indexer reads the on-chain registry.'),
    )
    return
  }

  if (allPools.length === 0) {
    setText(poolCount, '')
    tableHost.append(el('p', { class: 'muted' }, 'No pools yet. Launch one to get started.'))
    setText(pageStatus, '')
    return
  }

  const volumeOf = volumeValuer(CONFIG.trustedTokens, usdcxDecimals())
  const filtered = filterPools(allPools)
  setText(poolCount, `${filtered.length} pool${filtered.length === 1 ? '' : 's'}`)
  if (filtered.length === 0) {
    tableHost.append(el('p', { class: 'muted' }, 'No pool matches the filter.'))
    setText(pageStatus, '')
    pagePrev.disabled = true
    pageNext.disabled = true
    return
  }

  // Legacy pools always sit below the supported ones, whatever the sort. Above
  // them, the pinned pools keep the order the deployment lists them, then
  // whatever sort the reader chose.
  const volumes = new Map(
    allPools.map((pool) => [pool.id.toLowerCase(), volumeOf(pool)] as const),
  )
  const pinned = (id: string): number => {
    const at = CONFIG.pinnedPools.indexOf(id.toLowerCase())
    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }
  const sorted = [...filtered].sort((left, right) => {
    const byLegacy = Number(left.legacy === true) - Number(right.legacy === true)
    if (byLegacy !== 0) return byLegacy
    const byPin = pinned(left.id) - pinned(right.id)
    return byPin !== 0 ? byPin : comparePools(left, right, volumes)
  })
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize))
  if (pageIndex >= pages) pageIndex = pages - 1
  const start = pageIndex * pageSize
  const slice = sorted.slice(start, start + pageSize)

  const table = el(
    'table',
    { class: 'pool-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        sortHeader('Pool', 'pair'),
        el('th', { class: 'num' }, 'Price'),
        el('th', { class: 'num' }, 'Reserves'),
        sortHeader('Volume 24h', 'volume', 'num hide-sm'),
        sortHeader('Fee', 'fee', 'num'),
        sortHeader('Fee APR', 'apr', 'num'),
        el('th', { class: 'open-col' }, ''),
      ),
    ),
    el('tbody', {}, ...slice.map((pool) => poolRow(pool, volumes))),
  )
  tableHost.append(table)

  setText(
    pageStatus,
    `${start + 1}–${Math.min(start + pageSize, sorted.length)} of ${sorted.length} · page ${pageIndex + 1}/${pages}`,
  )
  pagePrev.disabled = pageIndex <= 0
  pageNext.disabled = pageIndex >= pages - 1
}

/** A header that sorts the table on click or Enter. */
function sortHeader(label: string, key: SortKey, className = ''): HTMLTableCellElement {
  const active = sortKey === key
  const direction = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
  const arrow = active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''
  const toggle = (): void => {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey = key
      // Numbers read best largest first; names read best A to Z.
      sortDir = key === 'pair' ? 'asc' : 'desc'
    }
    pageIndex = 0
    renderTable()
  }
  return el(
    'th',
    {
      class: className,
      role: 'button',
      tabindex: 0,
      'aria-sort': direction,
      title: 'Sort',
      onclick: toggle,
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggle()
        }
      },
    },
    `${label}${arrow}`,
  )
}

/** Pools matching the filter by symbol, pair, or faucet id. */
function filterPools(list: TablePool[]): TablePool[] {
  const visible = showLegacy ? list : list.filter((pool) => !pool.legacy)
  const query = filterInput.value.trim().toLowerCase().replace(/^0x/, '')
  if (!query) return visible
  return visible.filter((pool) => {
    const view = views.get(pool.id.toLowerCase())
    const symbols = view === undefined ? [] : [view.token0Symbol, view.token1Symbol]
    const ids = [pool.token0, pool.token1].map((id) => id.toLowerCase().replace(/^0x/, ''))
    const pair =
      view === undefined ? '' : `${view.token0Symbol}/${view.token1Symbol}`.toLowerCase()
    return (
      symbols.some((symbol) => symbol.toLowerCase().includes(query)) ||
      pair.includes(query) ||
      ids.some((id) => id.includes(query))
    )
  })
}

/** The value under a sort key. Strings compare as names, numbers as numbers. */
function sortValue(
  pool: IndexerPool,
  key: SortKey,
  volumes: Map<string, PoolVolume>,
): string | number {
  const view = views.get(pool.id.toLowerCase())
  switch (key) {
    case 'pair':
      return view === undefined
        ? pool.id.toLowerCase()
        : `${view.token0Symbol} / ${view.token1Symbol}`.toLowerCase()
    case 'volume': {
      // Valued in the fee asset at par, the same rule as the protocol totals. A
      // pool with no counted leg has no comparable volume and sorts last.
      const volume = volumes.get(pool.id.toLowerCase())
      return volume === undefined || !volume.counted ? -1 : Number(volume.base)
    }
    case 'fee':
      return Number(pool.lp_fee_bps)
    case 'apr':
      return feeAprOneDay(pool.fee_apr, pool.fee_apr_window_secs)
  }
}

function comparePools(
  a: IndexerPool,
  b: IndexerPool,
  volumes: Map<string, PoolVolume>,
): number {
  const left = sortValue(a, sortKey, volumes)
  const right = sortValue(b, sortKey, volumes)
  let order =
    typeof left === 'string' && typeof right === 'string'
      ? left.localeCompare(right)
      : Number(left) - Number(right)
  if (order === 0) order = a.id.localeCompare(b.id)
  return sortDir === 'asc' ? order : -order
}

function poolRow(pool: TablePool, volumes: Map<string, PoolVolume>): HTMLTableRowElement {
  const id = pool.id.toLowerCase()
  const view = views.get(id)
  const volume = volumes.get(id)
  const link = `/pool.html?id=${encodeURIComponent(id)}`
  if (view === undefined) {
    return el('tr', {}, el('td', { colspan: 7, class: 'muted' }, shortHex(id)))
  }
  const legacy = pool.legacy === true
  const seedOnly = pool.seedOnly === true
  const price = legacy || seedOnly ? null : poolPrice(pool, view)
  const reserve0 = BigInt(pool.reserve0)
  const reserve1 = BigInt(pool.reserve1)

  return el(
    'tr',
    legacy ? { class: 'legacy-row' } : {},
    el(
      'td',
      {},
      // A pointer target over the whole row for a mouse. It carries no name of
      // its own: the link in the last cell is the row's one accessible link.
      el('a', { class: 'row-link', href: link, tabindex: -1, 'aria-hidden': 'true' }),
      el('span', { class: 'pair' }, `${view.token0Symbol} / ${view.token1Symbol}`),
      legacy
        ? el(
            'span',
            { class: 'badge', title: 'Runs an older contract version. Withdrawals only.' },
            'Legacy',
          )
        : seedOnly
          ? el(
              'span',
              { class: 'badge badge-muted', title: 'No liquidity providers; the ratio is not a market price.' },
              'No LP',
            )
          : null,
      el('span', { class: 'sub mono', title: id }, shortHex(id)),
    ),
    el(
      'td',
      { class: 'num' },
      el('span', { class: 'figure' }, price ?? '—'),
      price === null ? null : el('span', { class: 'sub' }, `${view.token1Symbol} per ${view.token0Symbol}`),
    ),
    // Compact, because the exact reserves of two tokens set the width of the
    // whole table; the exact amount is the tooltip.
    el(
      'td',
      { class: 'num' },
      line(
        compactAmount(reserve0, view.token0Decimals),
        view.token0Symbol,
        `${formatAmount(reserve0, view.token0Decimals)} ${view.token0Symbol}`,
      ),
      line(
        compactAmount(reserve1, view.token1Decimals),
        view.token1Symbol,
        `${formatAmount(reserve1, view.token1Decimals)} ${view.token1Symbol}`,
      ),
    ),
    el(
      'td',
      { class: 'num hide-sm' },
      legacy || volume === undefined || !volume.counted
        ? el(
            'span',
            {
              class: 'figure',
              title: 'No stablecoin leg in this pool, so its volume is not valued in USDCX.',
            },
            '—',
          )
        : line(
            compactAmount(volume.base, usdcxDecimals()),
            'USDCX',
            `${formatAmount(volume.base, usdcxDecimals())} USDCX`,
          ),
    ),
    el(
      'td',
      { class: 'num' },
      el('span', { class: 'figure' }, formatBps(BigInt(pool.lp_fee_bps))),
    ),
    legacy ? el('td', { class: 'num' }, '—') : feeAprCell(pool),
    // The arrow on a table row, a button on a card: the one link per row, so the
    // card itself stays free for selecting an amount or copying the pool id.
    el(
      'td',
      { class: 'open-col' },
      el(
        'a',
        {
          class: 'open-btn',
          href: link,
          'aria-label': `Open ${view.token0Symbol} / ${view.token1Symbol}`,
        },
        el('span', { class: 'open-label' }, 'Open pool'),
        el('span', { class: 'open', 'aria-hidden': 'true' }, '→'),
      ),
    ),
  )
}

/**
 * Fee APR: the fee yield the pool paid its liquidity providers, annualised over
 * the window the indexer measured. A pool watched for minutes has minutes of
 * history, and the number is worth exactly that much.
 */
function feeAprCell(pool: IndexerPool): HTMLTableCellElement {
  // `> 0` rather than `=== 0`: an indexer from before this field existed sends
  // nothing, and a missing window is not a measured zero.
  if (!(pool.fee_apr_window_secs > 0)) {
    return el(
      'td',
      { class: 'num' },
      el('span', { class: 'figure muted' }, '—'),
    )
  }
  return el(
    'td',
    { class: 'num' },
    el(
      'span',
      { class: 'figure accent' },
      formatRate(feeAprOneDay(pool.fee_apr, pool.fee_apr_window_secs)),
    ),
    el('span', { class: 'sub' }, '24h'),
  )
}

/** The price of one token0 in token1, or null for an empty pool. */
function poolPrice(pool: IndexerPool, view: PoolView): string | null {
  const scaled = priceScaled(
    { reserve0: pool.reserve0, reserve1: pool.reserve1 },
    view.token0Decimals,
    view.token1Decimals,
  )
  return scaled === null ? null : formatScaled(scaled)
}

/**
 * Matches the stats panel to the swap card's height. The card is never clipped;
 * the panel scrolls when its content is longer, and takes its natural height on
 * the stacked layout.
 */
function syncStatsHeight(): void {
  if (window.innerWidth <= 900) {
    statsPanel.style.height = ''
    return
  }
  statsPanel.style.height = `${Math.round(swapCard.getBoundingClientRect().height)}px`
}

/**
 * On mobile the stats belong under the table, not between the swap card and it;
 * on desktop they sit beside the card in the hero.
 */
function placeStats(): void {
  const mobile = window.matchMedia('(max-width: 900px)').matches
  const poolsPanel = tableHost.closest('.panel')
  if (mobile && poolsPanel) poolsPanel.after(statsPanel)
  else swapHero.append(statsPanel)
  syncStatsHeight()
}

/** USDCX decimals, for the stats figures. */
function usdcxDecimals(): number {
  return routeTokenMeta(CONFIG.chainFeeFaucetId)?.decimals ?? 6
}

/** Renders the protocol stats panel from the loaded pool set and the wallet. */
function renderStats(): void {
  const activePools = allPools.filter((pool) => !pool.legacy && !pool.seedOnly)
  if (activePools.length === 0) {
    for (const node of [statTvl, statVolume, statPools, statSwaps, statApr]) {
      setText(node, '—')
    }
    setText(statFooter, allPools.length > 0 ? `${allPools.length} unsupported` : '')
    return
  }
  // Totals count only the pools that hold the fee asset; a price derived from
  // another pool lets one dust pool set a token's worth.
  const decimals = usdcxDecimals()
  const totals = feeAssetTotals(activePools, CONFIG.trustedTokens, decimals)
  let swaps = 0
  const aprs: number[] = []
  for (const pool of activePools) {
    swaps += pool.swaps_24h
    // Fee APR is swap income; a pool whose only activity is a deposit has not
    // earned a fee yet, and its zero would drag the median down.
    if (pool.swaps_24h > 0) {
      aprs.push(feeAprOneDay(pool.fee_apr, pool.fee_apr_window_secs))
    }
  }
  setText(statTvl, `${formatAmount(totals.tvlBase, decimals)} USDCX`)
  setText(statVolume, `${formatAmount(totals.volumeBase, decimals)} USDCX`)
  setText(statPools, `${activePools.length} pool${activePools.length === 1 ? '' : 's'}`)
  setText(statSwaps, String(swaps))

  if (aprs.length === 0) {
    setText(statApr, '—')
  } else {
    aprs.sort((left, right) => left - right)
    const mid = Math.floor(aprs.length / 2)
    const median = aprs.length % 2 === 1 ? aprs[mid] : (aprs[mid - 1] + aprs[mid]) / 2
    setText(statApr, formatRate(median))
  }

  const footer: string[] = [CONFIG.network]
  if (indexerStatus?.version) footer.push(`indexer v${indexerStatus.version}`)
  if (indexerStatus !== null) {
    footer.push(`registry block ${indexerStatus.last_registry_block.toLocaleString('en-US')}`)
  }
  footer.push(`${activePools.length} pools indexed`)
  const unsupported = allPools.length - activePools.length
  if (unsupported > 0) {
    footer.push(`${unsupported} legacy`)
  }
  if (totals.excluded > 0) {
    footer.push(
      `${totals.excluded} ${totals.excluded === 1 ? 'pool holds' : 'pools hold'} no stablecoin`,
    )
  }
  setText(statFooter, footer.join(' · '))
  syncStatsHeight()
}

/** One amount per line inside a cell. `title` carries the exact amount. */
function line(amount: string, symbol: string, title?: string): Child {
  return el('span', { class: 'line', title }, `${amount} ${symbol}`)
}

/** Token metadata from the indexed pools: symbol and decimals by faucet id. */
function routeTokenMeta(faucetId: string): TokenEntry | null {
  // The route's ids carry `0x`; a wallet-reported faucet may not. Compare the
  // bare form so both resolve to the same token.
  const wanted = normalizeHex(faucetId)
  const verified = verifiedMeta.get(`0x${wanted}`)
  if (verified) return verified
  for (const pool of activePools()) {
    if (normalizeHex(pool.token0) === wanted && pool.token0_decimals !== null) {
      return { symbol: pool.token0_symbol ?? shortHex(faucetId), decimals: pool.token0_decimals }
    }
    if (normalizeHex(pool.token1) === wanted && pool.token1_decimals !== null) {
      return { symbol: pool.token1_symbol ?? shortHex(faucetId), decimals: pool.token1_decimals }
    }
  }
  return null
}

/** The indexed token set: faucet id to symbol and decimals, sorted by symbol. */
function activePools(): TablePool[] {
  // Routable and countable pools only: not legacy, and not a seed with no LP.
  return allPools.filter((pool) => !pool.legacy && !pool.seedOnly)
}

function routeTokenEntries(): Array<[string, TokenEntry]> {
  const tokens = new Map<string, { symbol: string; decimals: number }>()
  for (const pool of activePools()) {
    const entries = [
      [pool.token0, pool.token0_symbol, pool.token0_decimals],
      [pool.token1, pool.token1_symbol, pool.token1_decimals],
    ] as const
    for (const [id, symbol, decimals] of entries) {
      if (decimals === null) continue
      tokens.set(id.toLowerCase(), { symbol: symbol ?? shortHex(id), decimals })
    }
  }
  return [...tokens.entries()].sort((left, right) =>
    left[1].symbol.localeCompare(right[1].symbol),
  )
}

/** The pay side offers only the wallet's tokens that an indexed pool trades. */
function payTokenSource(): TokenSource {
  if (!walletStore.get().connected) {
    return { entries: [], emptyNote: 'Login to load your tokens.' }
  }
  if (walletTokensState === 'loading') {
    return { entries: [], emptyNote: 'Loading your tokens …' }
  }
  if (walletTokens === null) {
    return { entries: [], emptyNote: 'No tradable token in this wallet.' }
  }
  return { entries: walletTokens }
}

/** The receive side offers only tokens routable from the selected pay token. */
function receiveTokenSource(): TokenSource {
  const all = routeTokenEntries()
  const pay = routeTokenIn.value.toLowerCase()
  if (!pay) return { entries: all }
  const reachable = reachableTokens(routerPools(activePools()), pay)
  const entries = all.filter(([id]) => reachable.has(id.toLowerCase()))
  return {
    entries,
    emptyNote: entries.length === 0 ? 'No token is routable from this one.' : undefined,
  }
}

/**
 * Runs when the pay token changes: a receive token that is no longer routable
 * from it is cleared, then the quote is rebuilt.
 */
function onPayTokenChanged(): void {
  renderRouteTokenLabels()
  // A new pay token makes the old amount meaningless; start it empty.
  routeAmount.value = ''
  const pay = routeTokenIn.value.toLowerCase()
  if (pay && routeTokenOut.value) {
    const reachable = reachableTokens(routerPools(activePools()), pay)
    if (!reachable.has(routeTokenOut.value.toLowerCase())) {
      routeTokenOut.value = ''
      routeOutCombo.refresh()
    }
  }
  onInputsChanged()
}

/**
 * The inputs a route was built from changed: an interrupted route no longer
 * applies, so the button returns to Swap and any retry state is dropped.
 */
function onInputsChanged(): void {
  pendingRoute = null
  routeSubmit.textContent = 'Swap'
  renderRouteQuote()
}

/**
 * Refreshes the wallet's tradable tokens. One run at a time: the store can
 * change many times while a refresh is in flight, and each failed wallet call
 * emits another change.
 */
async function refreshWalletTokens(): Promise<void> {
  if (walletTokensInFlight) return
  walletTokensInFlight = true
  try {
    await refreshWalletTokensInner()
  } finally {
    walletTokensInFlight = false
    renderRouteQuote()
    renderStats()
  }
}

async function refreshWalletTokensInner(): Promise<void> {
  if (!walletStore.get().connected) {
    walletTokens = null
    walletTokensState = 'idle'
    return
  }
  walletTokensState = 'loading'
  try {
    // A fresh read: the wallet may have received or spent assets since the last
    // one, and the adapter reports assets from its last sync.
    await syncWallet()
  } catch (error) {
    console.warn('[wallet] sync before the asset read failed:', error)
  }
  try {
    const supported = new Map(
      routeTokenEntries().map(([id, meta]) => [normalizeHex(id), meta] as const),
    )
    const found = new Map<string, TokenEntry>()
    // A wallet may report hex ids or bech32 addresses; both normalize to one
    // key. `sdkModule` loads only here, on the connected path.
    const { AccountId } = await sdkModule()
    for (const asset of await requestAssets()) {
      const raw = asset.faucetId.trim()
      let key: string
      try {
        key = normalizeHex(isHexId(raw) ? raw : AccountId.fromBech32(raw).toString())
      } catch {
        continue
      }
      const meta = supported.get(key)
      if (!meta) continue
      let amount = 0n
      try {
        amount = BigInt(asset.amount)
      } catch {
        // A malformed amount is shown as zero rather than dropped.
      }
      found.set(`0x${key}`, { ...meta, amount })
    }
    walletTokens = found.size > 0 ? [...found.entries()] : null
  } catch (error) {
    console.error('[wallet] asset read failed:', error)
    walletTokens = null
  }
  walletTokensState = 'ready'
}

/** Fills both token selects from the routing set, preserving the selection. */
function renderRouteTokens(): void {
  const options = routeTokenEntries()
  const known = new Set(options.map(([id]) => id))
  const previousIn = routeTokenIn.value.toLowerCase()
  const previousOut = routeTokenOut.value.toLowerCase()
  for (const select of [routeTokenIn, routeTokenOut]) {
    clear(select)
    // A placeholder keeps the browser from selecting the first token when the
    // options are appended; an empty card must stay empty.
    select.append(el('option', { value: '' }, 'Select token'))
    for (const [id, meta] of options) {
      select.append(el('option', { value: id }, `${meta.symbol} ${shortAddress(id)}`))
    }
  }
  // No auto-selection: an empty card starts empty. A selected token survives a
  // refresh only while it is still in the set.
  if (known.has(previousIn)) routeTokenIn.value = previousIn
  if (known.has(previousOut)) routeTokenOut.value = previousOut
  renderRouteTokenLabels()
}

/** Updates the two token inputs from the selects. */
function renderRouteTokenLabels(): void {
  routeTokenInInput.value = routeTokenMeta(routeTokenIn.value)?.symbol ?? ''
  routeTokenOutInput.value = routeTokenMeta(routeTokenOut.value)?.symbol ?? ''
}

/** Slippage tolerance in basis points, read from the percent field. */
function slippageBps(): bigint {
  return parseSlippagePercent(routeSlippage.value)
}

/** A decimal string for an input field: no grouping, trailing zeros trimmed. */
function plainAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const intPart = (amount / base).toString()
  const frac = (amount % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return frac ? `${intPart}.${frac}` : intPart
}

/** The wallet balance of the pay token, under the amount field. */
function renderRouteBalance(): void {
  const pay = routeTokenIn.value.toLowerCase()
  const meta = pay ? routeTokenMeta(pay) : null
  const held = walletTokens?.find(([id]) => id.toLowerCase() === pay)
  if (!meta || !held) {
    setText(routeBalanceIn, '')
    return
  }
  setText(
    routeBalanceIn,
    `Balance: ${formatAmount(held[1].amount ?? 0n, meta.decimals)} ${meta.symbol}`,
  )
}

/** Keeps the amount field to digits and one dot, at most `decimals` fraction digits. */
function sanitizeAmountInput(value: string, decimals: number): string {
  const cleaned = value.replace(/[^\d.]/g, '')
  const parts = cleaned.split('.')
  const intPart = (parts[0] ?? '').slice(0, 30)
  if (parts.length === 1) return intPart
  return `${intPart}.${parts.slice(1).join('').slice(0, decimals)}`
}

/** Enables or disables the submit button, unless a run is in flight. */
function setRouteButton(enabled: boolean, label: string): void {
  // A paused deployment refuses every swap, a held route refuses a resubmit,
  // and an unverified route is not submitted.
  const blocked =
    routeRunning || !enabled || !CONFIG.tradingEnabled || routeHeld || verifyingRoute || !routeVerified
  routeSubmit.disabled = blocked
  if (routeRunning) return
  routeSubmit.textContent = !CONFIG.tradingEnabled
    ? 'Under maintenance'
    : routeHeld
      ? 'Check your wallet'
      : verifyingRoute
        ? 'Verifying on chain…'
        : !routeVerified
          ? 'Unverified route'
          : label
}

/** Renders the best route for the current inputs. */
/** Progress, quote, and receipt rows share one labelled layout. */
function detailRow(label: string, value: string): Node {
  return el('p', {}, el('span', { class: 'muted' }, label), el('span', {}, value))
}

/** The output token per one input token at the given amounts. */
function routeRate(
  amountIn: bigint,
  amountOut: bigint,
  metaIn: TokenEntry,
  metaOut: TokenEntry,
): string {
  if (amountIn === 0n) return '—'
  return formatAmount(
    (amountOut * 10n ** BigInt(metaIn.decimals)) / amountIn,
    metaOut.decimals,
  )
}

/** The LP fee a route keeps: the part of the input the pools take. */
function routeFee(
  route: Route,
  pools: readonly IndexerPool[],
): { bps: bigint; amount: bigint } {
  const kept = route.hops.reduce((product, hop) => {
    const pool = pools.find((entry) => entry.id.toLowerCase() === hop.poolId)
    return (product * (10_000n - BigInt(pool?.lp_fee_bps ?? 0))) / 10_000n
  }, 10_000n)
  const bps = 10_000n - kept
  return { bps, amount: (route.amountIn * bps) / 10_000n }
}

/** The route path in token symbols, the way the quote's Route row shows it. */
function routePath(route: Route): string {
  const symbolOf = (id: string): string => routeTokenMeta(id)?.symbol ?? shortAddress(id)
  return routeTokens(route).map(symbolOf).join(' → ')
}

/**
 * Shows the route in the status box with the hop awaiting confirmation in
 * bold, so the wallet prompt and the path agree.
 */
function renderRouteProgress(route: Route, activeHop: number, message: string): void {
  const symbolOf = (id: string): string => routeTokenMeta(id)?.symbol ?? shortAddress(id)
  const tokens = routeTokens(route)
  const nodes: Child[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (index > 0) {
      nodes.push(
        el('span', { class: index - 1 === activeHop ? 'route-hop-active' : '' }, ' → '),
      )
    }
    const active = index === activeHop || index === activeHop + 1
    nodes.push(el('span', { class: active ? 'route-hop-active' : '' }, symbolOf(tokens[index])))
  }
  clear(routeStatus)
  routeStatus.append(
    el('p', { class: 'route-path' }, ...nodes),
    el('p', { class: 'flow-message' }, message),
  )
}

/** The swap's parameters and outcome, kept in the status box after the bell. */
function renderSwapReceipt(route: Route, result: RouteResult): void {
  const metaIn = routeTokenMeta(route.hops[0].tokenIn)
  const metaOut = routeTokenMeta(route.hops[route.hops.length - 1].tokenOut)
  if (!metaIn || !metaOut) return
  const symbolOf = (id: string): string => routeTokenMeta(id)?.symbol ?? shortAddress(id)
  // The last hop's output is the quote: no read of the wallet happens after it,
  // because the output note arrives on its own schedule.
  const last = result.hops[result.hops.length - 1]
  const received = last?.actual ? last.amountOut : result.amountOut
  const quoted = last?.actual ? '' : ' (quoted)'
  const fee = routeFee(route, activePools())
  const network = result.hops.reduce((sum, hop) => sum + hop.fee, 0n)
  const feeAsset = result.hops.find((hop) => hop.feeFaucetId)?.feeFaucetId ?? ''
  const notes = result.hops.filter((hop) => hop.fee > 0n).length
  // The headline names the path, so a single-hop route needs no Route row.
  const lines: Node[] = [
    detailRow(
      'Rate',
      `1 ${metaIn.symbol} = ${routeRate(route.amountIn, received, metaIn, metaOut)} ${metaOut.symbol}`,
    ),
    detailRow(
      'LP fee',
      `${formatAmount(fee.amount, metaIn.decimals)} ${metaIn.symbol} (${formatBps(fee.bps)})`,
    ),
    detailRow('Price impact', formatBps(route.costBps)),
  ]
  if (route.hops.length > 1) {
    lines.push(detailRow('Route', routePath(route)))
    result.hops.forEach((hop, index) => {
      const inMeta = routeTokenMeta(hop.tokenIn)
      const outMeta = routeTokenMeta(hop.tokenOut)
      if (!inMeta || !outMeta) return
      lines.push(
        detailRow(
          `Hop ${index + 1}`,
          `${formatAmount(hop.amountIn, inMeta.decimals)} ${inMeta.symbol} → ${formatAmount(hop.amountOut, outMeta.decimals)} ${outMeta.symbol}${hop.actual ? '' : ' (quoted)'}`,
        ),
      )
    })
  }
  const transactions = `${result.txIds.length} transaction${result.txIds.length === 1 ? '' : 's'}`
  const foot =
    network > 0n
      ? `${transactions} · network fee ${network} base units of ${symbolOf(feeAsset)} (${notes} swap note${notes === 1 ? '' : 's'})`
      : transactions
  clear(routeStatus)
  routeStatus.append(
    el(
      'p',
      { class: 'receipt-head' },
      `Swapped ${formatAmount(route.amountIn, metaIn.decimals)} ${metaIn.symbol} for ${formatAmount(received, metaOut.decimals)} ${metaOut.symbol}${quoted}`,
    ),
    el('div', { class: 'receipt' }, ...lines),
    el('p', { class: 'receipt-foot' }, foot),
  )
}

/**
 * Re-quotes a route for the same input so a retry does not inherit stale
 * amounts. Returns the same route when the pools still price it identically, and
 * the stale one when no route exists any more: the resume point is worth more
 * than a fresh quote that cannot be computed.
 */
function retireRoute(route: Route): Route {
  const tokens = routeTokens(route)
  const from = tokens[0]
  const to = tokens[tokens.length - 1]
  const fresh = findRoutes(routerPools(activePools()), from, to, route.amountIn)[0]
  return fresh ?? route
}

/**
 * Verifies a route against the chain before it can be submitted: every pool in
 * it must be listed in the registry, and every token's decimals and symbol are
 * read from its faucet account. The indexer supplies the list and the quote;
 * the chain decides what may be traded and how the amount is parsed.
 */
async function verifyRoute(route: Route): Promise<void> {
  const key = route.hops
    .map((hop) => `${hop.poolId.toLowerCase()}:${hop.tokenIn.toLowerCase()}:${hop.tokenOut.toLowerCase()}`)
    .join('|')
  if (key === verifiedRouteKey && routeVerified) return
  if (key === failedRouteKey) return
  if (verifyingRoute) return
  verifyingRoute = true
  routeVerified = false
  setRouteButton(false, 'Swap')
  try {
    const listed = await listedPools(route.hops.map((hop) => hop.poolId))
    for (const hop of route.hops) {
      if (!listed.has(normalizeHex(hop.poolId))) {
        throw new Error(`Pool ${shortHex(hop.poolId)} is not listed in the chain registry.`)
      }
    }
    const { BasicFungibleFaucetComponent } = await sdkModule()
    const tokens = Array.from(
      new Set(route.hops.flatMap((hop) => [hop.tokenIn.toLowerCase(), hop.tokenOut.toLowerCase()])),
    )
    for (const token of tokens) {
      if (verifiedMeta.has(token)) continue
      const account = await getPublicAccount(token)
      const meta = BasicFungibleFaucetComponent.fromAccount(account)
      verifiedMeta.set(token, {
        decimals: meta.decimals(),
        symbol: meta.symbol().toString(),
      })
    }
    verifiedRouteKey = key
    routeVerified = true
    failedRouteKey = ''
    // Reparse and re-quote with the verified decimals.
    renderRouteQuote()
  } catch (error) {
    failedRouteKey = key
    routeVerified = false
    setText(
      routeStatus,
      `Cannot verify this route on chain: ${error instanceof Error ? error.message : String(error)} Trading stays disabled until it can be verified.`,
    )
  } finally {
    verifyingRoute = false
    setRouteButton(routeBest !== null, pendingRoute ? 'Retry' : 'Swap')
  }
}

function renderRouteQuote(): void {
  clear(routeQuote)
  routeBest = null
  renderRouteBalance()
  const stop = (message: string): void => {
    routeQuote.append(el('p', { class: 'muted' }, message))
    setRouteButton(false, 'Swap')
  }
  // A failure the user must fix reads in the error colour, not grey.
  const fail = (message: string): void => {
    routeQuote.append(el('p', { class: 'error' }, message))
    setRouteButton(false, 'Swap')
  }
  if (CONFIG.indexerUrl.length === 0) {
    setRouteButton(false, 'Swap')
    return
  }
  const from = routeTokenIn.value
  const to = routeTokenOut.value
  if (!from || !to) {
    stop(activePools().length === 0 ? 'No pools to route through yet.' : 'Pick two tokens.')
    return
  }
  if (from === to) {
    stop('Pick two different tokens.')
    return
  }
  const metaIn = routeTokenMeta(from)
  const metaOut = routeTokenMeta(to)
  if (!metaIn || !metaOut) {
    fail('Token metadata is missing.')
    return
  }
  if (!walletStore.get().connected) {
    routeQuote.append(el('p', { class: 'muted' }, 'Connect a wallet to swap.'))
    setRouteButton(false, 'Connect wallet to swap')
    return
  }
  let amountIn: bigint
  try {
    amountIn = parseAmount(routeAmount.value, metaIn.decimals)
  } catch {
    fail('Enter a valid amount.')
    return
  }
  if (amountIn <= 0n) {
    stop('Enter an amount.')
    return
  }
  if (walletTokensState === 'loading') {
    stop('Loading your wallet balance …')
    return
  }
  const held = walletTokens?.find(([id]) => id.toLowerCase() === from.toLowerCase())
  const balance = held?.[1].amount ?? 0n
  if (!held || balance === 0n) {
    fail(`The wallet holds none of ${metaIn.symbol}.`)
    return
  }
  if (amountIn > balance) {
    fail(
      `Amount exceeds your balance of ${formatAmount(balance, metaIn.decimals)} ${metaIn.symbol}.`,
    )
    return
  }
  let slippage: bigint
  try {
    slippage = slippageBps()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return
  }

  const pools = routerPools(activePools())
  const best = findRoutes(pools, from, to, amountIn)[0]
  if (!best) {
    const direct = pools.find(
      (pool) =>
        (pool.token0 === from.toLowerCase() && pool.token1 === to.toLowerCase()) ||
        (pool.token1 === from.toLowerCase() && pool.token0 === to.toLowerCase()),
    )
    const minimum = direct ? minInputForOneOut(direct, from, to) : 0n
    fail(
      minimum > 0n
        ? `Amount too small: at least ${formatAmount(minimum, metaIn.decimals)} ${metaIn.symbol} pays one base unit.`
        : 'No route through the listed pools.',
    )
    return
  }
  routeBest = best
  void verifyRoute(best)
  routeAmountOut.value = formatAmount(best.amountOut, metaOut.decimals)

  const minimum = (best.amountOut * (10_000n - slippage)) / 10_000n
  setText(routeMinOut, `min ${formatAmount(minimum, metaOut.decimals)} ${metaOut.symbol}`)

  const rate = routeRate(best.amountIn, best.amountOut, metaIn, metaOut)
  const fee = routeFee(best, activePools())
  const lines: Node[] = [
    detailRow('Rate', `1 ${metaIn.symbol} = ${rate} ${metaOut.symbol}`),
    detailRow(
      'LP fee',
      `${formatAmount(fee.amount, metaIn.decimals)} ${metaIn.symbol} (${formatBps(fee.bps)})`,
    ),
    detailRow('Price impact', formatBps(best.costBps)),
    detailRow('Route', routePath(best)),
  ]
  if (slippage > 500n) {
    lines.push(
      el(
        'p',
        { class: 'error slippage-warning' },
        `Slippage ${formatBps(slippage)} is high: this swap can fill that far from the quote, ` +
          'and a trade at that price is worse than waiting.',
      ),
    )
  }
  if (best.hops.length > 1) {
    lines.push(detailRow('Hops', `${best.hops.length} transactions`))
  }
  if (best.costBps > 1500n) {
    lines.push(
      el('p', { class: 'error' }, 'Price impact above 15%: this pool is very shallow.'),
    )
  }
  routeQuote.append(...lines)
  setRouteButton(true, pendingRoute ? 'Retry' : 'Swap')
  syncStatsHeight()
}

async function doRouteSwap(): Promise<void> {
  if (!routeVerified || verifyingRoute) {
    toast('The route is still being verified on chain. Try again in a moment.', 'error')
    return
  }
  const pending = pendingRoute
  // A retry keeps the resume point, not the old quote: the first attempt may
  // have failed because reserves moved, and reusing its amounts would fail the
  // same way every time. Re-quote the same input along the same path.
  const route = pending ? retireRoute(pending.route) : routeBest
  if (!route) {
    toast('No route to swap.', 'error')
    return
  }
  let slippage: bigint
  try {
    slippage = slippageBps()
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'error')
    return
  }
  routeSubmit.disabled = true
  routeSubmit.textContent = 'Swap'
  routeRunning = true
  // A browser starts audio only from a user gesture; this click is one, and the
  // context then serves the completion bell minutes later.
  primeSound()
  renderRouteProgress(
    route,
    pending?.nextHop ?? 0,
    pending ? `Retrying from hop ${pending.nextHop + 1}…` : 'Starting…',
  )
  try {
    const result = await executeRoute({
      route,
      pools: activePools(),
      slippageBps: slippage,
      startHop: pending?.nextHop ?? 0,
      startStage: pending?.stage,
      startAmountIn: pending?.amountIn,
      startBalanceBefore: pending?.balanceBefore,
      onHop: (index, amountIn, balanceBefore, stage) => {
        pendingRoute = { route, nextHop: index, amountIn, balanceBefore, stage }
      },
      onProgress: (progress: RouteProgress) =>
        renderRouteProgress(route, progress.index, progress.message),
    })
    pendingRoute = null
    routeSubmit.textContent = 'Swap'
    playArrivalBell()
    renderSwapReceipt(route, result)
    toast(`Swap complete: ${result.txIds.length} transaction${result.txIds.length === 1 ? '' : 's'}`)
    void refresh({ manual: true })
    // The wallet now holds the output token: reload balances and the pay list so
    // the next swap can start from what was just received.
    void refreshWalletTokens()
  } catch (error) {
    if (error instanceof HopFailure) {
      if (error.refund) {
        // The pool paid the hop's input back: nothing is pending, so a retry is
        // safe, but the refund note must be accepted before it can be spent.
        if (pendingRoute) pendingRoute = { ...pendingRoute, stage: 'submit' }
        const paid = error.refund.assets
          .map((asset) => {
            const meta = routeTokenMeta(asset.faucetId)
            return `${formatAmount(asset.amount, meta?.decimals ?? 0)} ${meta?.symbol ?? shortHex(asset.faucetId)}`
          })
          .join(' + ')
        routeSubmit.textContent = 'Retry'
        renderRouteProgress(
          route,
          error.hopIndex,
          `The pool refunded hop ${error.hopIndex + 1}: ${paid} came back. Accept the refund in your wallet, then retry.`,
        )
      } else if (error.unknown) {
        routeHeld = true
        renderRouteProgress(
          route,
          error.hopIndex,
          `${error.message} Do not resubmit: check your wallet, then reload.`,
        )
      } else {
        routeSubmit.textContent = 'Retry'
        renderRouteProgress(
          route,
          error.hopIndex,
          `${error.message} Retry to continue from hop ${error.hopIndex + 1}.`,
        )
      }
    } else {
      toast(error instanceof Error ? error.message : String(error), 'error')
      setText(routeStatus, '')
    }
  } finally {
    routeRunning = false
    setRouteButton(routeBest !== null, pendingRoute ? 'Retry' : 'Swap')
  }
}

routePercents.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-percent]')
  if (!button) return
  const pay = routeTokenIn.value.toLowerCase()
  const meta = routeTokenMeta(pay)
  const held = walletTokens?.find(([id]) => id.toLowerCase() === pay)
  if (!meta || !held) {
    toast('Connect a wallet that holds the pay token.', 'error')
    return
  }
  const percent = BigInt(button.dataset.percent ?? '0')
  const amount = ((held[1].amount ?? 0n) * percent) / 100n
  if (amount <= 0n) {
    toast('The wallet holds none of the pay token.', 'error')
    return
  }
  routeAmount.value = plainAmount(amount, meta.decimals)
  onInputsChanged()
})

// The amount field takes digits and one dot only. Letters, extra dots, and
// fraction digits beyond the token's decimals are dropped as they are typed.
routeAmount.addEventListener('input', () => {
  const decimals = routeTokenMeta(routeTokenIn.value)?.decimals ?? 18
  const next = sanitizeAmountInput(routeAmount.value, decimals)
  if (next === routeAmount.value) return
  const caret = routeAmount.selectionStart ?? next.length
  routeAmount.value = next
  const position = Math.min(caret, next.length)
  routeAmount.setSelectionRange(position, position)
})

routeForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void doRouteSwap()
})
routeForm.addEventListener('input', onInputsChanged)
routeForm.addEventListener('change', onInputsChanged)

routeSettingsToggle.addEventListener('click', () => {
  routeSettings.hidden = !routeSettings.hidden
  routeSettingsToggle.setAttribute('aria-expanded', String(!routeSettings.hidden))
})

routeFlip.addEventListener('click', () => {
  const from = routeTokenIn.value
  routeTokenIn.value = routeTokenOut.value
  routeTokenOut.value = from
  onPayTokenChanged()
})

// The stats panel follows the swap card's height, which changes as the quote
// details appear and disappear.
new ResizeObserver(() => syncStatsHeight()).observe(swapCard)
window.addEventListener('resize', syncStatsHeight)
window.matchMedia('(max-width: 900px)').addEventListener('change', placeStats)
placeStats()

mountTokenCombo(
  routeTokenInInput,
  routeTokenIn,
  payTokenSource,
  (id) => routeTokenMeta(id)?.symbol ?? shortAddress(id),
  onPayTokenChanged,
)
const routeOutCombo = mountTokenCombo(
  routeTokenOutInput,
  routeTokenOut,
  receiveTokenSource,
  (id) => routeTokenMeta(id)?.symbol ?? shortAddress(id),
  onInputsChanged,
)
// The token list follows the connected address, not every store update. The
// adapter emits error and ready-state events continuously when it is unhappy,
// and refreshing on those looped: refresh, failed wallet call, error event,
// refresh. Only a connection change can change the token list.
walletStore.subscribe(() => {
  const state = walletStore.get()
  const address = state.connected && state.address ? state.address : null
  if (address === walletTokensFor) return
  walletTokensFor = address
  void refreshWalletTokens()
})

/**
 * Fetches on load, then polls while the tab is visible. A hidden tab skips the
 * tick so a background page does not keep polling; becoming visible triggers
 * one immediately.
 */
function mountAutoRefresh(): void {
  void refresh()
  void refreshWalletTokens()
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, REFRESH_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
}

mountAutoRefresh()
