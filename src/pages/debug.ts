/**
 * Hidden wallet debug page. Unlinked and noindex. It exists to prove
 * wallet-side behaviour the app cannot assert in a unit test: whether Bread
 * turns `recallBlocks` into a P2IDE, and whether a refund note arrives after a
 * trade the pool cannot fill.
 */
import { addLiquidity, fetchPoolState, NOTE_FEES, removeLiquidity, swap } from '@port0.sh/sdk'
import { getClient, getPublicAccount, sdkModule } from '../lib/client'
import { CONFIG } from '../lib/config'
import { el, qs, setText } from '../lib/dom'
import { mountSite } from '../lib/site'
import { mountWallet } from '../wallet/ui'
import {
  consumableNotes,
  consumeNote,
  sendViaWallet,
  submitViaWallet,
  syncWallet,
  waitForTransaction,
  walletAccountId,
  walletStore,
} from '../wallet/wallet'

const logNode = qs<HTMLPreElement>(document, '#log')
function log(message: string): void {
  logNode.textContent = `${new Date().toISOString()} ${message}\n${logNode.textContent ?? ''}`
}

start()

function start(): void {
  mountWallet()
  mountSite()
  const walletSlot = qs<HTMLElement>(document, '#wallet-slot')
  const walletState = qs<HTMLElement>(document, '#wallet-state')
  walletSlot.hidden = false
  walletStore.subscribe((state) => {
    setText(walletState, state.connected ? `connected: ${state.address ?? ''}` : 'disconnected')
  })

  qs<HTMLInputElement>(document, '#send-faucet').value = CONFIG.chainFeeFaucetId

  qs<HTMLButtonElement>(document, '#sync').addEventListener('click', async () => {
    try {
      await syncWallet()
      const summary = await (await getClient()).syncChain()
      setText(qs<HTMLElement>(document, '#height'), `block ${summary.blockNum()}`)
      log(`synced at block ${summary.blockNum()}`)
    } catch (error) {
      log(`sync failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  qs<HTMLFormElement>(document, '#send-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const recipient = qs<HTMLInputElement>(document, '#send-recipient').value.trim()
    const faucet = qs<HTMLInputElement>(document, '#send-faucet').value.trim()
    const amount = Number(qs<HTMLInputElement>(document, '#send-amount').value)
    try {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer')
      const txId = await sendViaWallet(recipient, faucet, amount, { recall: true })
      log(`send submitted: ${txId}`)
      await waitForTransaction(txId)
      log(`send confirmed: ${txId}`)
    } catch (error) {
      log(`send failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  qs<HTMLButtonElement>(document, '#notes').addEventListener('click', async () => {
    const host = qs<HTMLElement>(document, '#notes-list')
    host.replaceChildren()
    try {
      const notes = await consumableNotes()
      if (notes.length === 0) {
        log('no consumable notes')
        return
      }
      for (const note of notes) {
        const asset = note.assets[0]
        const row = el(
          'p',
          { class: 'mono' },
          `${note.noteId} · ${asset ? `${asset.amount} of ${asset.faucetId}` : 'no asset'} · ${note.state}`,
        )
        if (asset) {
          const button = el('button', { class: 'btn' }, 'Consume') as HTMLButtonElement
          button.addEventListener('click', async () => {
            try {
              const txId = await consumeNote(
                asset.faucetId,
                note.noteId,
                note.noteType === 0 ? 'private' : 'public',
                Number(asset.amount),
              )
              log(`consume submitted: ${note.noteId} · ${txId}`)
              await waitForTransaction(txId)
              log(`consume confirmed: ${note.noteId}`)
            } catch (error) {
              log(`consume failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          })
          row.append(' ', button)
        }
        host.append(row)
      }
      log(`${notes.length} consumable note(s)`)
    } catch (error) {
      log(`note list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  qs<HTMLFormElement>(document, '#fault-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      const { AccountId } = await sdkModule()
      const sender = await walletAccountId()
      if (!sender) throw new Error('wallet not connected')
      const client = await getClient()
      const poolId = AccountId.fromHex(qs<HTMLInputElement>(document, '#fault-pool').value.trim())
      const operation = qs<HTMLSelectElement>(document, '#fault-op').value
      const mode = qs<HTMLSelectElement>(document, '#fault-mode').value
      const amount0 = BigInt(qs<HTMLInputElement>(document, '#fault-amount0').value)
      const amount1Raw = qs<HTMLInputElement>(document, '#fault-amount1').value
      const amount1 = amount1Raw.length > 0 ? BigInt(amount1Raw) : 0n
      await getPublicAccount(poolId.toString())
      const state = await fetchPoolState((id) => client.accounts.get(id), poolId)

      // A decimal scale, applied to the quote only: above one for a swap or a
      // burn, below one for a deposit, so the quoted minimum cannot be met.
      const rawScale = qs<HTMLInputElement>(document, '#fault-scale').value.trim()
      const [whole, fraction = ''] = rawScale.split('.')
      const denominator = 10n ** BigInt(fraction.length)
      const numerator = BigInt(whole || '0') * denominator + BigInt(fraction || '0')
      if (numerator <= 0n) throw new Error('quote scale must be positive')
      // The scale is a quote error factor: above one always makes the quoted
      // minimum unreachable. A deposit is quoted from a shallower pool, a swap
      // and a burn from a deeper one.
      const [reserveNumerator, reserveDenominator] =
        operation === 'add' ? [denominator, numerator] : [numerator, denominator]
      const quoted = {
        ...state,
        reserve0: (state.reserve0 * reserveNumerator) / reserveDenominator,
        reserve1: (state.reserve1 * reserveNumerator) / reserveDenominator,
      }

      const now = BigInt(Math.floor(Date.now() / 1000))
      const deadline = mode === 'expired' ? now - 3_600n : 0n
      const config = {
        poolId,
        feeFaucetId: AccountId.fromHex(CONFIG.chainFeeFaucetId),
        noteFees: NOTE_FEES,
      }
      const quoteState = mode === 'expired' ? state : quoted
      const common = { sender, recipient: sender, slippageBps: 0n, deadline }

      let request
      let minimum: string
      if (operation === 'swap') {
        const tokenRaw = qs<HTMLInputElement>(document, '#fault-token').value.trim()
        const tokenIn = tokenRaw.length > 0 ? AccountId.fromHex(tokenRaw) : state.token0FaucetId
        const result = await swap(
          client,
          config,
          quoteState,
          { ...common, tokenIn, amountIn: amount0 },
          { submit: false },
        )
        request = result.request
        minimum = `min out ${result.minAmountOut.toString()}`
      } else if (operation === 'add') {
        const result = await addLiquidity(
          client,
          config,
          quoteState,
          { ...common, amount0, amount1 },
          { submit: false },
        )
        request = result.request
        minimum = `min LP ${result.minLpOut.toString()}`
      } else {
        const result = await removeLiquidity(
          client,
          config,
          quoteState,
          { ...common, amountLp: amount0 },
          { submit: false },
        )
        request = result.request
        minimum = `min out ${result.minAmount0.toString()}/${result.minAmount1.toString()}`
      }

      const txId = await submitViaWallet(request)
      log(`faulty ${operation} (${mode}) submitted: ${txId}; ${minimum}`)
      await waitForTransaction(txId)
      log('confirmed; the refund arrives as a P2ID. Open Wallet notes to accept it.')
    } catch (error) {
      log(`faulty trade failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
