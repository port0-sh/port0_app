/**
 * "Send public note" panel.
 *
 * Uses the wallet's own `requestSend` endpoint with noteType "public", the
 * same path the launchpad funding uses. The wallet builds and signs the
 * transaction itself, so there is no multisig fee-salt handling here. A
 * public note is published on-chain and discoverable by its target on the
 * next sync, unlike Bread's UI sends, which are private.
 */

import { CONFIG } from '../lib/config'
import { qs, setText } from '../lib/dom'
import { parseAmount, shortHex } from '../lib/format'
import { toast } from '../ui/toast'
import {
  sendViaWallet,
  waitForTransaction,
  walletAccountId,
} from '../wallet/wallet'

/** USDCX (the chain fee asset) has 6 decimals. */
const FEE_ASSET_DECIMALS = 6

export function mountSendPublicNote(): void {
  const form = qs<HTMLFormElement>(document, '#public-note-form')
  const recipientInput = qs<HTMLInputElement>(document, '#public-note-recipient')
  const amountInput = qs<HTMLInputElement>(document, '#public-note-amount')
  const status = qs<HTMLSpanElement>(document, '#public-note-status')
  const button = qs<HTMLButtonElement>(form, 'button[type="submit"]')

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })

  async function send(): Promise<void> {
    button.disabled = true
    setText(status, '')
    try {
      const sender = await walletAccountId()
      if (!sender) throw new Error('Login first.')

      const recipient = recipientInput.value.trim()
      if (!recipient) throw new Error('Recipient is required.')
      const amount = parseAmount(amountInput.value, FEE_ASSET_DECIMALS)
      if (amount <= 0n) throw new Error('Amount must be positive.')

      // requestSend takes a number, not bigint (adapter API).
      setText(status, 'Requesting wallet signature…')
      const txId = await sendViaWallet(
        recipient,
        CONFIG.chainFeeFaucetId,
        Number(amount),
      )
      setText(status, `Submitted ${shortHex(txId)}; confirming…`)
      const { txHash } = await waitForTransaction(txId)
      toast(`Public note sent: ${shortHex(txHash)}`)
      setText(status, 'Sent.')
    } catch (error) {
      console.error('[send-public-note]', error)
      setText(status, error instanceof Error ? error.message : String(error))
    } finally {
      button.disabled = false
    }
  }
}
