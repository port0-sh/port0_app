import { describe, expect, it } from 'vitest'
import type { InputNoteDetails } from '@miden-sdk/miden-wallet-adapter-base'
import { normalizeHex } from './format'
import { findRefund } from './refund'

const POOL = '0x52832d9b5beed2d1671600ac5fa9b6'
const MICO = '0x0ef591811ece2c512379926e32ba23'
const USDCX = '0x4cbdcaffe75f0a317482224dae6436'

function note(
  id: string,
  sender: string | undefined,
  assets: Array<[string, string]>,
): InputNoteDetails {
  return {
    noteId: id,
    senderAccountId: sender,
    assets: assets.map(([faucetId, amount]) => ({ faucetId, amount })),
    noteType: undefined,
    nullifier: '',
    state: 'pending',
  } as unknown as InputNoteDetails
}

describe('findRefund', () => {
  it('finds the note the pool sent back for one input faucet', async () => {
    const refund = await findRefund([note('0xaa', POOL, [[MICO, '293289679']])], POOL, [MICO])
    expect(refund?.note.noteId).toBe('0xaa')
    expect(refund?.assets).toEqual([{ faucetId: normalizeHex(MICO), amount: 293289679n }])
  })

  it('carries both assets of an add refund', async () => {
    const refund = await findRefund(
      [note('0xbb', POOL, [[MICO, '761846638'], [USDCX, '15385133']])],
      POOL,
      [MICO, USDCX],
    )
    expect(refund?.assets.map((asset) => asset.faucetId)).toEqual([
      normalizeHex(MICO),
      normalizeHex(USDCX),
    ])
  })

  it('ignores another sender, another faucet, a zero amount, and a seen note', async () => {
    expect(await findRefund([note('0xcc', '0x1234', [[MICO, '1']])], POOL, [MICO])).toBeNull()
    expect(await findRefund([note('0xdd', POOL, [[USDCX, '5']])], POOL, [MICO])).toBeNull()
    expect(await findRefund([note('0xee', POOL, [[MICO, '0']])], POOL, [MICO])).toBeNull()
    expect(
      await findRefund([note('0xff', POOL, [[MICO, '1']])], POOL, [MICO], new Set(['0xff'])),
    ).toBeNull()
  })

  it('normalizes ids the wallet reported in another case', async () => {
    const refund = await findRefund(
      [note('0x11', POOL.toUpperCase(), [[MICO.toUpperCase(), '7']])],
      POOL,
      [MICO],
    )
    expect(refund?.assets[0].amount).toBe(7n)
  })
})
