/**
 * Multihop execution.
 *
 * A route runs hop by hop through the connected wallet. Each hop is its own
 * wallet transaction: the pool consumes the swap note and emits a P2ID note of
 * the output token to the sender, so the intermediate asset has to reach the
 * wallet's vault before the next hop can spend it. A note the user accepted in
 * the wallet counts just as much as one still pending, which is why the wait
 * looks at the balance as well as at the consumable notes.
 *
 * The next hop's input is the amount the wallet actually received, not the
 * quote, so a reserve shift between hops changes only the final output.
 *
 * A failed hop throws `HopFailure` with the hop index, so the caller can offer a
 * retry that resumes at that hop instead of starting over.
 */

import { getFreshAccount, getXyk, sdkModule } from './client'
import { CONFIG } from './config'
import { isHexId, normalizeHex, shortHex, withHexPrefix } from './format'
import { fetchPool, toPoolView, type IndexerPool, type PoolView } from './indexer'
import type { Route } from './router'
import type { PoolConfig } from '@port0.sh/sdk'
import {
  consumableNotes,
  consumeNote,
  requestAssets,
  submitViaWallet,
  syncWallet,
  waitForTransaction,
  walletAccountId,
} from '../wallet/wallet'

/** What the card should ask the user to do, or tell them is happening. */
export type RoutePhase = 'confirm-submit' | 'waiting-output' | 'confirm-consume'

/** Progress callback payload for the swap card's status line. */
export interface RouteProgress {
  /** Zero-based hop index. */
  index: number
  /** Number of hops in the route. */
  total: number
  phase: RoutePhase
  message: string
}

/** Which part of a hop ran: the wallet swap, or accepting its output. */
export type HopStage = 'submit' | 'consume'

/** A hop that failed, carrying the hop and stage to resume from. */
export class HopFailure extends Error {
  readonly hopIndex: number
  readonly stage: HopStage

  constructor(message: string, hopIndex: number, stage: HopStage) {
    super(message)
    this.name = 'HopFailure'
    this.hopIndex = hopIndex
    this.stage = stage
  }
}

/** One hop as it executed, for the receipt the card shows afterwards. */
export interface ExecutedHop {
  tokenIn: string
  tokenOut: string
  /** Amount spent: the input, or the amount the previous hop actually paid. */
  amountIn: bigint
  /** Amount out. Read from the wallet for intermediate hops; quoted for the last. */
  amountOut: bigint
  /** True when `amountOut` came from the wallet rather than the quote. */
  actual: boolean
  /** Sponsorship the hop's swap note carried, from the pool's on-chain schedule. */
  fee: bigint
  /** Faucet the fee is denominated in; the pool's fee asset. */
  feeFaucetId: string
}

export interface RouteResult {
  /** Wallet transaction ids, hop submissions and intermediate consumes. */
  txIds: string[]
  /** Quoted amount of the final token. */
  amountOut: bigint
  /** Every hop, with the wallet's amounts where the executor saw them. */
  hops: ExecutedHop[]
}

/** How often to poll the wallet for an intermediate note or balance. */
const NOTE_POLL_MS = 5_000
/** How long to wait for an intermediate note before giving up. */
const NOTE_WAIT_MS = 180_000

/** Normalizes a faucet id the wallet reported, which may be bech32. */
async function normalizeFaucet(raw: string): Promise<string | null> {
  const value = raw.trim()
  if (isHexId(value)) return normalizeHex(value)
  try {
    const { AccountId } = await sdkModule()
    return normalizeHex(AccountId.fromBech32(value).toString())
  } catch {
    return null
  }
}

/**
 * The wallet's balance of `faucetId`, in base units, or null when the read
 * itself failed.
 *
 * Null and zero must stay distinct: a failed read treated as zero makes the
 * waiter below conclude that nothing arrived, and it then polls until the
 * timeout although the payout is sitting in the wallet.
 */
async function walletBalance(faucetId: string): Promise<bigint | null> {
  const wanted = normalizeHex(faucetId)
  try {
    for (const asset of await requestAssets()) {
      const key = await normalizeFaucet(asset.faucetId)
      if (key !== wanted) continue
      try {
        return BigInt(asset.amount)
      } catch {
        return 0n
      }
    }
  } catch {
    // No permission, or the wallet refused the read: the balance is unknown.
    return null
  }
  return 0n
}

/** The amount a hop guarantees at most `slippageBps` below its quote. */
function minOut(amountOut: bigint, slippageBps: bigint): bigint {
  return (amountOut * (10_000n - slippageBps)) / 10_000n
}

/** Accepts a payout note through the wallet and reports the consume transaction. */
async function acceptNote(
  note: { noteId: string; noteType?: unknown },
  amount: bigint,
  faucetId: string,
  wanted: string,
  onWait: (phase: RoutePhase, message: string) => void,
): Promise<Acquired> {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The intermediate amount is too large for a wallet consume request.')
  }
  const { NoteType } = await import('@miden-sdk/miden-sdk')
  onWait('confirm-consume', `Confirm accepting ${shortHex(wanted)} in your wallet…`)
  const consumeTxId = await consumeNote(
    faucetId,
    note.noteId,
    note.noteType === NoteType.Public ? 'public' : 'private',
    Number(amount),
  )
  return { amount, consumeTxId }
}

interface Acquired {
  /** The amount the wallet now holds from this hop. */
  amount: bigint
  /** The consume transaction, when a pending note had to be accepted. */
  consumeTxId?: string
}

/**
 * Waits until the wallet holds at least `minimum` of `faucetId` beyond
 * `balanceBefore`, then returns the amount received.
 *
 * A pending P2ID note is accepted through the wallet. A note the user already
 * accepted in the wallet shows up as a balance and needs no consume, which is
 * what makes an interrupted route resumable.
 */
async function acquireIntermediate(
  faucetId: string,
  minimum: bigint,
  balanceBefore: bigint,
  onWait: (phase: RoutePhase, message: string) => void,
): Promise<Acquired> {
  const wanted = normalizeHex(faucetId)
  const deadline = Date.now() + NOTE_WAIT_MS
  for (;;) {
    await syncWallet()

    const held = await walletBalance(wanted)
    const received = held !== null && held > balanceBefore ? held - balanceBefore : 0n
    if (received >= minimum) return { amount: received }

    // The gate above uses `minimum`, which comes from the route quote taken
    // before the hop ran. Reserves move, so the pool can legitimately pay less
    // than that quote while still respecting the request's own min-out. A note
    // of the right faucet therefore counts as the hop's payout even below
    // `minimum`; the hop's min-out already bounded the rate, and the next hop's
    // min-out bounds the continuation. Waiting for a stale figure instead is an
    // infinite wait on a payout that has arrived.
    const notes = await consumableNotes()
    let fallback: { note: (typeof notes)[number]; amount: bigint } | null = null
    for (const note of notes) {
      let amount: bigint | null = null
      for (const asset of note.assets) {
        const key = await normalizeFaucet(asset.faucetId)
        if (key !== wanted) continue
        try {
          amount = BigInt(asset.amount)
        } catch {
          amount = null
        }
        break
      }
      if (amount === null || amount === 0n) continue
      if (amount < minimum) {
        if (fallback === null || amount > fallback.amount) fallback = { note, amount }
        continue
      }
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('The intermediate amount is too large for a wallet consume request.')
      }
      return await acceptNote(note, amount, faucetId, wanted, onWait)
    }

    // A payout of this faucet is in the wallet but below the stale quote: take
    // the largest one. The hop executed under its own min-out, so a smaller
    // figure is the pool's actual payment, not a shortfall; the next hop's
    // min-out rejects a continuation that the amount cannot support, which is a
    // clear error rather than an endless wait.
    if (fallback !== null) {
      return await acceptNote(fallback.note, fallback.amount, faucetId, wanted, onWait)
    }

    if (Date.now() > deadline) {
      throw new Error(
        `The pool has not paid ${shortHex(wanted)} yet. Accept the token in your wallet and retry.`,
      )
    }
    onWait(
      'waiting-output',
      `Waiting for the pool to pay ${shortHex(wanted)}. Accept the token in your wallet when it arrives.`,
    )
    await new Promise((resolve) => setTimeout(resolve, NOTE_POLL_MS))
  }
}

/**
 * Executes `route` hop by hop. `pools` is the routing pool set the quote came
 * from; each hop's pool configuration (fee faucet, note fees) is read from it.
 *
 * `startHop`, `startStage`, `startAmountIn`, and `startBalanceBefore` resume an
 * interrupted route at exactly the stage that failed: a cancelled wallet swap
 * resubmits, while a cancelled accept re-acquires the hop's output without
 * swapping again. `onHop` reports the hop, amount, prior balance, and stage as
 * the executor reaches them, so the caller can persist them for a retry.
 */
export async function executeRoute(options: {
  route: Route
  pools: readonly IndexerPool[]
  slippageBps: bigint
  deadlineMarginSeconds: bigint
  startHop?: number
  startStage?: HopStage
  startAmountIn?: bigint
  startBalanceBefore?: bigint
  onProgress?: (progress: RouteProgress) => void
  onHop?: (index: number, amountIn: bigint, balanceBefore: bigint, stage: HopStage) => void
}): Promise<RouteResult> {
  const {
    route,
    pools,
    slippageBps,
    deadlineMarginSeconds,
    startHop = 0,
    startStage = 'submit',
    startAmountIn,
    startBalanceBefore = 0n,
    onProgress,
    onHop,
  } = options
  const sender = await walletAccountId()
  if (!sender) throw new Error('Login first.')
  const { AccountId } = await sdkModule()
  const xyk = await getXyk()

  const views = new Map<string, PoolView>()
  for (const pool of pools) {
    // The list endpoint omits the note fee schedule and the hop's config needs
    // it to size the sponsorship, so load the full record per hop pool.
    const full = CONFIG.indexerUrl ? await fetchPool(CONFIG.indexerUrl, pool.id) : null
    views.set(pool.id.toLowerCase(), await toPoolView(full ?? pool))
  }

  const txIds: string[] = []
  const total = route.hops.length
  let amountIn = startHop > 0 ? (startAmountIn ?? route.amountIn) : route.amountIn
  // Seeded from the quote so a resumed route still reports the whole path; the
  // hops that execute overwrite their entry with what the wallet saw.
  const executed: ExecutedHop[] = route.hops.map((hop) => ({
    tokenIn: hop.tokenIn,
    tokenOut: hop.tokenOut,
    amountIn: hop.amountIn,
    amountOut: hop.amountOut,
    actual: false,
    fee: 0n,
    feeFaucetId: '',
  }))

  for (let index = startHop; index < total; index += 1) {
    const hop = route.hops[index]
    const last = index === total - 1
    let stage: HopStage = index === startHop ? startStage : 'submit'
    executed[index] = { ...executed[index], amountIn }
    let balanceBefore = index === startHop && startStage === 'consume' ? startBalanceBefore : 0n
    try {
      if (stage === 'submit') {
        const view = views.get(hop.poolId)
        if (!view?.feeFaucetId) {
          throw new Error(`Pool ${hop.poolId} is missing its fee faucet id.`)
        }
        const noteFees = Object.fromEntries(
          Object.entries(view.noteFees).map(([kind, amount]) => [kind, BigInt(amount ?? '0')]),
        ) as PoolConfig['noteFees']
        const poolAccountId = AccountId.fromHex(withHexPrefix(view.poolId))
        const feeFaucetId = AccountId.fromHex(withHexPrefix(view.feeFaucetId))

        onHop?.(index, amountIn, balanceBefore, 'submit')
        onProgress?.({
          index,
          total,
          phase: 'confirm-submit',
          message:
            total === 1
              ? 'Confirm the swap in your wallet…'
              : `Confirm hop ${index + 1} of ${total} in your wallet…`,
        })

        // The pool account has to be in the local store before the SDK reads
        // its state, and the import refreshes it. Fetch, then sync, then build,
        // so the request's bound block and the wallet's anchor are read at one
        // height.
        await getFreshAccount(poolAccountId)
        await syncWallet()
        // An unknown balance must not be recorded as a snapshot: a zero would
        // make the waiter below read the whole payout as a delta of nothing.
        if (!last) balanceBefore = (await walletBalance(hop.tokenOut)) ?? 0n
        onHop?.(index, amountIn, balanceBefore, 'submit')

        executed[index] = {
          ...executed[index],
          fee: noteFees.swap ?? 0n,
          feeFaucetId: view.feeFaucetId,
        }
        const pool = xyk.pool({ poolId: poolAccountId, feeFaucetId, noteFees })
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + deadlineMarginSeconds
        const output = await pool.swap({
          sender,
          recipient: sender,
          tokenIn: AccountId.fromHex(withHexPrefix(hop.tokenIn)),
          amountIn,
          slippageBps,
          deadline,
        })
        const txId = await submitViaWallet(output.request)
        txIds.push(txId)
        await waitForTransaction(txId)
      }

      if (last) break

      stage = 'consume'
      onHop?.(index, amountIn, balanceBefore, 'consume')
      const acquired = await acquireIntermediate(
        hop.tokenOut,
        minOut(hop.amountOut, slippageBps),
        balanceBefore,
        (phase, message) => onProgress?.({ index, total, phase, message }),
      )
      if (acquired.consumeTxId) {
        onProgress?.({
          index,
          total,
          phase: 'confirm-consume',
          message: 'Confirm accepting the token in your wallet…',
        })
        txIds.push(acquired.consumeTxId)
        await waitForTransaction(acquired.consumeTxId)
      }
      executed[index] = { ...executed[index], amountOut: acquired.amount, actual: true }
      amountIn = acquired.amount
    } catch (error) {
      if (error instanceof HopFailure) throw error
      throw new HopFailure(error instanceof Error ? error.message : String(error), index, stage)
    }
  }

  return { txIds, amountOut: route.amountOut, hops: executed }
}
