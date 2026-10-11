/**
 * Utility: send a public note.
 *
 * Opens a modal with a recipient and an amount, and sends through the wallet's
 * own `requestSend` endpoint with noteType "public", the same path the launchpad
 * funding uses. The wallet builds and signs the transaction itself, so there is
 * no multisig fee-salt handling here. A public note is published on-chain and
 * discoverable by its target on the next sync, unlike Bread's own sends, which
 * are private and cannot reach an account that does not exist on-chain yet.
 */

import { CONFIG } from '../lib/config'
import { el, setText } from '../lib/dom'
import { parseAmount, shortHex } from '../lib/format'
import { openModal } from '../ui/modal'
import { toast } from '../ui/toast'
import { sendViaWallet, waitForTransaction, walletAccountId } from '../wallet/wallet'

/** USDCX, the chain fee asset, has 6 decimals. */
const FEE_ASSET_DECIMALS = 6

export function openSendPublicNote(): void {
  const recipientInput = el('input', {
    type: 'text',
    placeholder: 'bech32 or 0x…',
    spellcheck: false,
    required: true,
  })
  const amountInput = el('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0.000420',
    spellcheck: false,
    required: true,
  })
  const status = el('span', { class: 'muted' })
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Send')

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('label', {}, 'Recipient address'),
    recipientInput,
    el('label', {}, 'Amount (USDCX)'),
    amountInput,
    el('div', { class: 'form-actions' }, submit, status),
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })

  const handle = openModal('Send public note', form)

  async function send(): Promise<void> {
    submit.disabled = true
    setText(status, '')
    try {
      const sender = await walletAccountId()
      if (!sender) throw new Error('Connect a wallet first.')

      const recipient = recipientInput.value.trim()
      if (!recipient) throw new Error('Recipient is required.')
      const amount = parseAmount(amountInput.value, FEE_ASSET_DECIMALS)
      if (amount <= 0n) throw new Error('Amount must be positive.')

      // requestSend takes a number, not bigint (adapter API).
      setText(status, 'Waiting for the wallet…')
      const txId = await sendViaWallet(recipient, CONFIG.chainFeeFaucetId, Number(amount))
      setText(status, `Submitted ${shortHex(txId)}; confirming…`)
      const { txHash } = await waitForTransaction(txId)
      toast(`Public note sent: ${shortHex(txHash)}`)
      handle.close()
    } catch (error) {
      console.error('[send-public-note]', error)
      setText(status, error instanceof Error ? error.message : String(error))
    } finally {
      submit.disabled = false
    }
  }
}
