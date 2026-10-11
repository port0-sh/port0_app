/**
 * Home page: pool browsing.
 *
 * The pool list is the indexer's, which reads the on-chain registry. There is no
 * local pool list and no manual import. Prices and amounts are computed from the
 * indexer's reserves with the same exact bigint arithmetic the pool page uses,
 * so the Miden SDK is not loaded on this page at all.
 */

import { CONFIG } from '../lib/config'
import { clear, el, qs, setText, type Child } from '../lib/dom'
import {
  compactAmount,
  formatAmount,
  formatBps,
  formatDuration,
  formatRate,
  shortHex,
} from '../lib/format'
import { formatScaled, priceScaled } from '../lib/history'
import { fetchPools, toPoolView, type IndexerPool, type PoolView } from '../lib/indexer'
import { mountSiteChrome } from '../lib/site'
import { toast } from '../ui/toast'
import { mountWallet } from '../wallet/ui'

mountWallet()
mountSiteChrome()

const tableHost = qs<HTMLDivElement>(document, '#pool-table')
const filterInput = qs<HTMLInputElement>(document, '#pool-filter')
const loadMoreButton = qs<HTMLButtonElement>(document, '#load-more')
const poolCount = qs<HTMLElement>(document, '#pool-count')
const refreshButton = qs<HTMLButtonElement>(document, '#refresh-states')
const refreshStatus = qs<HTMLSpanElement>(document, '#refresh-status')

/**
 * Poll interval for the always-on list. Miden testnet produces a block about
 * every 3s; 15s is five blocks, so a swap or deposit appears within that.
 */
const REFRESH_INTERVAL_MS = 15_000

let pools: IndexerPool[] = []
let views = new Map<string, PoolView>()
let nextCursor: string | null = null
let refreshing = false
let firstRefreshDone = false

/** Page size for the first load and for each "Load more". */
const PAGE_SIZE = 50

refreshButton.addEventListener('click', () => {
  void refresh({ manual: true })
})

loadMoreButton.addEventListener('click', () => {
  void loadMore()
})

// Re-filtering on submit or after a pause, not on every keystroke.
filterInput.addEventListener('change', () => {
  void refresh({ manual: true })
})

renderTable()

async function refresh(options: { manual?: boolean } = {}): Promise<void> {
  if (refreshing) return
  if (CONFIG.indexerUrl.length === 0) {
    renderTable()
    return
  }
  refreshing = true
  if (options.manual || !firstRefreshDone) setText(refreshStatus, 'Refreshing…')
  try {
    // Refresh the window the page has already loaded, so a poll does not
    // collapse pages the user pulled in. Capped by the API's own limit.
    const wanted = Math.max(PAGE_SIZE, pools.length)
    const page = await fetchPools(CONFIG.indexerUrl, {
      token: filterInput.value.trim() || undefined,
      limit: wanted,
    })
    await adoptPage(page.pools, page.nextCursor)
    setText(refreshStatus, `updated ${new Date().toLocaleTimeString()}`)
  } catch (error) {
    if (options.manual) {
      toast(error instanceof Error ? error.message : 'Pool list is unavailable.', 'error')
      setText(refreshStatus, '')
    }
  } finally {
    refreshing = false
    firstRefreshDone = true
  }
}

/** Appends the next page, keeping what is already rendered. */
async function loadMore(): Promise<void> {
  if (refreshing || nextCursor === null) return
  refreshing = true
  setText(refreshStatus, 'Loading…')
  try {
    const page = await fetchPools(CONFIG.indexerUrl, {
      token: filterInput.value.trim() || undefined,
      cursor: nextCursor,
      limit: PAGE_SIZE,
    })
    await adoptPage([...pools, ...page.pools], page.nextCursor)
    setText(refreshStatus, `updated ${new Date().toLocaleTimeString()}`)
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Pool list is unavailable.', 'error')
    setText(refreshStatus, '')
  } finally {
    refreshing = false
  }
}

/**
 * Installs a page: resolves each pool's symbols, replaces the rendered list,
 * and shows "Load more" only while the indexer offers a next cursor.
 */
async function adoptPage(indexed: IndexerPool[], cursor: string | null): Promise<void> {
  const resolved = new Map<string, PoolView>()
  for (const pool of indexed) {
    // The list shows symbols and reserves, not note fees, so the WASM SDK
    // stays out of this page's dependency graph.
    resolved.set(pool.id.toLowerCase(), await toPoolView(pool, false))
  }
  pools = indexed
  views = resolved
  nextCursor = cursor
  loadMoreButton.hidden = cursor === null
  loadMoreButton.disabled = false
  renderTable()
}

function renderTable(): void {
  clear(tableHost)

  if (CONFIG.indexerUrl.length === 0) {
    setText(poolCount, '')
    tableHost.append(
      el('p', { class: 'muted' }, 'Set VITE_INDEXER_URL to list pools. The indexer reads the on-chain registry.'),
    )
    return
  }

  if (pools.length === 0) {
    setText(poolCount, '')
    tableHost.append(el('p', { class: 'muted' }, 'No pools yet. Launch one to get started.'))
    return
  }

  setText(poolCount, `${pools.length} pool${pools.length === 1 ? '' : 's'}`)
  const table = el(
    'table',
    { class: 'pool-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, 'Pool'),
        el('th', { class: 'num' }, 'Price'),
        el('th', { class: 'num' }, 'Reserves'),
        el('th', { class: 'num hide-sm' }, 'Volume 24h'),
        el('th', { class: 'num' }, 'Fee'),
        el('th', { class: 'num' }, 'Yield'),
        el('th', { class: 'open-col' }, ''),
      ),
    ),
    el('tbody', {}, ...sortedPools().map(poolRow)),
  )
  tableHost.append(table)
}

/** Pairs in alphabetical order, so a row keeps its place between refreshes. */
function sortedPools(): IndexerPool[] {
  const name = (pool: IndexerPool): string => {
    const view = views.get(pool.id.toLowerCase())
    return view === undefined
      ? pool.id.toLowerCase()
      : `${view.token0Symbol} / ${view.token1Symbol}`.toLowerCase()
  }
  return [...pools].sort(
    (a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id),
  )
}

function poolRow(pool: IndexerPool): HTMLTableRowElement {
  const id = pool.id.toLowerCase()
  const view = views.get(id)
  const link = `/pool.html?id=${encodeURIComponent(id)}`
  if (view === undefined) {
    return el('tr', {}, el('td', { colspan: 7, class: 'muted' }, shortHex(id)))
  }
  const price = poolPrice(pool, view)

  return el(
    'tr',
    {},
    el(
      'td',
      {},
      // Stretched over the row, so the whole row opens the pool rather than the
      // pair name alone.
      el('a', {
        class: 'row-link',
        href: link,
        'aria-label': `Open ${view.token0Symbol} / ${view.token1Symbol}`,
      }),
      el('span', { class: 'pair' }, `${view.token0Symbol} / ${view.token1Symbol}`),
      el('span', { class: 'sub mono', title: id }, shortHex(id)),
    ),
    el(
      'td',
      { class: 'num' },
      el('span', { class: 'figure' }, price ?? '—'),
      price === null ? null : el('span', { class: 'sub' }, `${view.token1Symbol} per ${view.token0Symbol}`),
    ),
    el(
      'td',
      { class: 'num' },
      line(formatAmount(BigInt(pool.reserve0), view.token0Decimals), view.token0Symbol),
      line(formatAmount(BigInt(pool.reserve1), view.token1Decimals), view.token1Symbol),
    ),
    el(
      'td',
      { class: 'num hide-sm' },
      line(compactAmount(BigInt(pool.volume_24h_0), view.token0Decimals), view.token0Symbol),
      line(compactAmount(BigInt(pool.volume_24h_1), view.token1Decimals), view.token1Symbol),
    ),
    el('td', { class: 'num' }, el('span', { class: 'figure' }, formatBps(BigInt(pool.lp_fee_bps)))),
    yieldCell(pool),
    el('td', { class: 'open-col' }, el('span', { class: 'open', 'aria-hidden': 'true' }, '→')),
  )
}

/**
 * The fee yield the pool paid its liquidity providers, with the window it is
 * annualised over. A pool the indexer has watched for minutes has minutes of
 * history, and the number is worth exactly that much.
 */
function yieldCell(pool: IndexerPool): HTMLTableCellElement {
  // `> 0` rather than `=== 0`: an indexer from before this field existed sends
  // nothing, and a missing window is not a measured zero.
  if (!(pool.fee_apr_window_secs > 0)) {
    return el('td', { class: 'num' }, el('span', { class: 'figure muted' }, '—'))
  }
  return el(
    'td',
    { class: 'num' },
    el('span', { class: 'figure accent' }, formatRate(pool.fee_apr)),
    el('span', { class: 'sub' }, `over ${formatDuration(pool.fee_apr_window_secs)}`),
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

/** One amount per line inside a cell. */
function line(amount: string, symbol: string): Child {
  return el('span', { class: 'line' }, `${amount} ${symbol}`)
}

/**
 * Fetches on load, then polls while the tab is visible. A hidden tab skips the
 * tick so a background page does not keep polling; becoming visible triggers
 * one immediately.
 */
function mountAutoRefresh(): void {
  void refresh()
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, REFRESH_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
}

mountAutoRefresh()
