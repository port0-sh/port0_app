/**
 * Utils page. Two chain utilities that previously lived in the wallet menu:
 * one-time mint and send public note. Both need a connected wallet, so the
 * buttons stay disabled and the hint stays visible until one connects.
 */

import { openOneTimeMint } from '../features/oneTimeMint'
import { openSendPublicNote } from '../features/sendPublicNote'
import { mountSite } from '../lib/site'
import { mountWallet } from '../wallet/ui'
import { walletStore } from '../wallet/wallet'

mountWallet()
mountSite()

const mint = document.getElementById('util-mint')
const send = document.getElementById('util-send')
const hint = document.getElementById('util-hint')

mint?.addEventListener('click', () => openOneTimeMint())
send?.addEventListener('click', () => openSendPublicNote())

function render(): void {
  const { connected } = walletStore.get()
  for (const button of [mint, send]) {
    if (button instanceof HTMLButtonElement) button.disabled = !connected
  }
  if (hint) hint.hidden = connected
}

walletStore.subscribe(render)
render()
