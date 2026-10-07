/**
 * Launchpad reproduction against the real 0.17 testnet, run from Node.
 *
 * Uses a deterministic test account (VITE_TEST_ACCOUNT_SEED) that must be
 * funded with USDCX first. The user sends a public USDCX note to the account
 * address before the first run; the script consumes it as the account's first
 * transaction and then drives the full launchpad sequence.
 *
 * Run: node scripts/launchpad-repro.mjs [two-tx|batch]
 */

import { readFileSync } from 'node:fs'
import { MidenClient } from '@miden-sdk/miden-sdk'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => l.split('=').map((s) => s.trim())),
)

const SEED = env.VITE_TEST_ACCOUNT_SEED
const RPC = 'https://rpc.testnet.miden.io'
const FEE_FAUCET = '0x4cbdcaffe75f0a317482224dae6436'
const FUNDING_AMOUNT = 1_000n
const SUPPLY = 10_000_000_000n // 1M tokens at 4 decimals

const mode = process.argv[2] ?? 'two-tx'

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

async function findFirstNote(client, accountId) {
  for (let i = 0; i < 30; i++) {
    const summary = await client.syncChain()
    summary.free()
    const notes = await client.notes.listAvailable({ account: accountId })
    const id = notes[0]?.id()
    if (id) {
      const str = id.toString()
      id.free()
      for (const n of notes) n.free()
      return str
    }
    for (const n of notes) n.free()
    await new Promise((r) => setTimeout(r, 4000))
  }
  return null
}

const client = await MidenClient.create({
  rpcUrl: RPC,
  feeFaucetId: FEE_FAUCET,
  autoSync: false,
  proverUrl: 'testnet',
  storeName: 'miden-xyk-launchpad-test',
})

// Step A: the funded test account (same seed every run).
const account = await client.accounts.create({ seed: SEED, storage: 'private' })
const accountId = account.id()
log('test account:', accountId.toString())

// Consume any pending funding note (first tx: creates account on-chain).
const accountNote = await findFirstNote(client, accountId)
if (accountNote) {
  log('consuming funding note:', accountNote.slice(0, 14))
  await client.transactions.consume({
    account: accountId,
    notes: [accountNote],
    waitForConfirmation: true,
  })
  log('test account on-chain and funded')
} else {
  log('no funding note for test account (fund it first)')
}

// Step B: launchpad sequence.
const faucet = await client.accounts.create({
  type: 'FungibleFaucet',
  storage: 'public',
  name: 'TEST',
  symbol: 'TEST',
  decimals: 4,
  maxSupply: SUPPLY,
  auth: 'falcon',
})
const faucetId = faucet.id()
log('faucet created locally:', faucetId.toString())

// Fund the faucet from the test account (this is what the wallet does).
log('funding faucet with', FUNDING_AMOUNT.toString(), 'USDCX base units')
const send = await client.transactions.send({
  account: accountId,
  to: faucetId,
  token: FEE_FAUCET,
  amount: FUNDING_AMOUNT,
  type: 'public',
  waitForConfirmation: true,
})
send.free?.()
log('faucet funded, tx:', send.txId?.toString?.()?.slice(0, 14))

const fundingNote = await findFirstNote(client, faucetId)
if (!fundingNote) {
  throw new Error('faucet funding note not found')
}
log('faucet funding note:', fundingNote.slice(0, 14))

if (mode === 'batch') {
  log('running batch consume+mint')
  await client.transactions.batch({
    account: faucetId,
    operations: [
      { kind: 'consume', notes: [fundingNote] },
      { kind: 'mint', to: accountId, amount: SUPPLY, type: 'public' },
    ],
    waitForConfirmation: true,
  })
  log('BATCH OK')
} else {
  log('running consume (first tx)')
  await client.transactions.consume({
    account: faucetId,
    notes: [fundingNote],
    waitForConfirmation: true,
  })
  log('consume OK')
  log('running mint (second tx)')
  await client.transactions.mint({
    account: faucetId,
    to: accountId,
    amount: SUPPLY,
    type: 'public',
    waitForConfirmation: true,
  })
  log('MINT OK')
}

log('DONE')
