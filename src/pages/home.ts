/**
 * Home page: pool browsing and import.
 *
 * The registry table renders immediately from localStorage; on-chain state
 * (reserves, fees) is fetched lazily through the "Refresh" button because it
 * pulls the multi-megabyte Miden SDK into the page.
 */

import { getPublicAccount } from '../lib/client'
import { clear, el, qs } from '../lib/dom'
import { formatAmount, formatBps, shortHex } from '../lib/format'
import { registry, type PoolRecord } from '../lib/registry'
import { toast } from '../ui/toast'
import { mountSendPublicNote } from '../features/sendPublicNote'
import { mountSiteChrome } from '../lib/site'
import { mountWallet } from '../wallet/ui'

mountWallet()
mountSiteChrome()
mountSendPublicNote()

const tableHost = qs<HTMLDivElement>(document, '#pool-table')
const importForm = qs<HTMLFormElement>(document, '#import-form')
const importStatus = qs<HTMLSpanElement>(document, '#import-status')
const importButton = qs<HTMLButtonElement>(importForm, 'button[type="submit"]')
const refreshButton = qs<HTMLButtonElement>(document, '#refresh-states')
const refreshStatus = qs<HTMLSpanElement>(document, '#refresh-status')

interface PoolRowState {
  reserve0?: bigint
  reserve1?: bigint
  lpFeeBps?: bigint
  lpSupply?: bigint
  configured?: boolean
  error?: string
}

let rowStates = new Map<string, PoolRowState>()

renderTable()
registry.subscribe(renderTable)

function renderTable(): void {
  const records = registry.list()
  clear(tableHost)

  if (records.length === 0) {
    tableHost.append(
      el(
        'p',
        { class: 'muted' },
        'No pools yet. Import one by account id below, or create a pool.',
      ),
    )
    return
  }

  const table = el(
    'table',
    {},
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, 'Pair'),
        el('th', {}, 'Pool'),
        el('th', {}, 'Token faucets'),
        el('th', {}, 'Fee faucet'),
        el('th', {}, 'Reserves'),
        el('th', {}, 'LP fee'),
        el('th', {}, 'Added'),
        el('th', {}),
      ),
    ),
    el('tbody', {}, ...records.map(recordRow)),
  )
  tableHost.append(
    table,
    el(
      'p',
      { class: 'muted' },
      `${records.length} pool${records.length === 1 ? '' : 's'} in the local registry.`,
    ),
  )
}

function recordRow(record: PoolRecord): HTMLTableRowElement {
  const state = rowStates.get(record.poolId)
  const link = `/pool.html?id=${encodeURIComponent(record.poolId)}`

  const reservesCell = state?.error
    ? el('span', { class: 'error' }, state.error)
    : state?.reserve0 !== undefined && state.reserve1 !== undefined
      ? el(
          'span',
          {},
          `${formatAmount(state.reserve0, record.token0Decimals)} ${record.token0Symbol} / `,
          `${formatAmount(state.reserve1, record.token1Decimals)} ${record.token1Symbol}`,
        )
      : el('span', { class: 'muted' }, '—')

  return el(
    'tr',
    {},
    el(
      'td',
      {},
      el(
        'a',
        { href: link },
        `${record.token0Symbol} / ${record.token1Symbol}`,
      ),
      record.feeFaucetId === null
        ? el('span', { class: 'muted', title: 'Imported without fee faucet; trading disabled.' }, 'read-only')
        : null,
    ),
    el(
      'td',
      { class: 'mono' },
      el('a', { href: link, title: record.poolId }, shortHex(record.poolId)),
    ),
    el(
      'td',
      { class: 'mono' },
      el(
        'span',
        { title: record.token0FaucetId },
        shortHex(record.token0FaucetId),
      ),
      ' / ',
      el(
        'span',
        { title: record.token1FaucetId },
        shortHex(record.token1FaucetId),
      ),
    ),
    el(
      'td',
      { class: 'mono' },
      record.feeFaucetId === null
        ? el('span', { class: 'muted' }, '—')
        : el('span', { title: record.feeFaucetId }, shortHex(record.feeFaucetId)),
    ),
    el('td', {}, reservesCell),
    el('td', {}, state?.lpFeeBps !== undefined ? formatBps(state.lpFeeBps) : '—'),
    el('td', { class: 'muted' }, new Date(record.addedAt).toLocaleDateString()),
    el(
      'td',
      {},
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          title: 'Remove from registry',
          onclick: () => registry.remove(record.poolId),
        },
        '✕',
      ),
    ),
  )
}

refreshButton.addEventListener('click', () => {
  void refreshStates()
})

async function refreshStates(): Promise<void> {
  const records = registry.list()
  if (records.length === 0) {
    toast('No pools in the registry.')
    return
  }
  refreshButton.disabled = true
  refreshStatus.textContent = 'Refreshing…'
  try {
    const { decodePoolState } = await import('miden-xyk-sdk')
    const next = new Map<string, PoolRowState>()
    for (const record of records) {
      try {
        const account = await getPublicAccount(record.poolId)
        const state = decodePoolState(account)
        next.set(record.poolId, {
          reserve0: state.reserve0,
          reserve1: state.reserve1,
          lpFeeBps: state.fees.lpFeeBps,
          lpSupply: state.lpSupply,
          configured: state.configured,
        })
      } catch (error) {
        next.set(record.poolId, {
          error: error instanceof Error ? error.message : 'unavailable',
        })
      }
    }
    rowStates = next
    renderTable()
    refreshStatus.textContent = ''
  } finally {
    refreshButton.disabled = false
  }
}

importForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void doImport()
})

async function doImport(): Promise<void> {
  const input = qs<HTMLInputElement>(importForm, '#pool-id')
  const raw = input.value.trim()
  if (!raw) return
  importButton.disabled = true
  importStatus.textContent = 'Importing…'
  try {
    const { decodePoolState, isXykPool } = await import('miden-xyk-sdk')
    const account = await getPublicAccount(raw)
    if (!isXykPool(account)) {
      throw new Error('That account is not an XYK pool.')
    }
    const state = decodePoolState(account)
    if (!state.configured) {
      throw new Error('Pool is deployed but not configured yet (no admin note).')
    }
    const { BasicFungibleFaucetComponent } = await import('@miden-sdk/miden-sdk')
    const [faucet0, faucet1] = await Promise.all([
      getPublicAccount(state.token0FaucetId),
      getPublicAccount(state.token1FaucetId),
    ])
    const meta0 = BasicFungibleFaucetComponent.fromAccount(faucet0)
    const meta1 = BasicFungibleFaucetComponent.fromAccount(faucet1)

    registry.add({
      poolId: state.accountId.toString(),
      feeFaucetId: null,
      noteFees: {},
      token0FaucetId: state.token0FaucetId.toString(),
      token1FaucetId: state.token1FaucetId.toString(),
      token0Symbol: meta0.symbol().toString(),
      token1Symbol: meta1.symbol().toString(),
      token0Decimals: meta0.decimals(),
      token1Decimals: meta1.decimals(),
      addedAt: Date.now(),
    })
    input.value = ''
    importStatus.textContent = ''
    toast(
      `Imported ${meta0.symbol()}/${meta1.symbol()} pool. Trading is disabled: the fee faucet id is unknown.`,
    )
  } catch (error) {
    importStatus.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    importButton.disabled = false
  }
}
