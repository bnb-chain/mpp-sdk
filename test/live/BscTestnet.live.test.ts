/**
 * BSC Testnet live e2e (spec §15 DoD).
 *
 * Status: SCAFFOLD ONLY — every test is `it.todo` pending the human
 * gating below. CI must NOT run this file by default (vite.config.ts
 * already isolates it to the `live` project).
 *
 * To enable:
 *
 *   1. Pin a real BscScan-verified `TEST_USDT` contract address in
 *      `src/server/curated.ts` (current value is sentinel zero — see
 *      spec §5.3).
 *
 *   2. Provide testnet RPC + signing key via environment:
 *
 *        BSC_TESTNET_RPC_URL          // e.g. https://data-seed-prebsc-1-s1.binance.org:8545
 *        BSC_TESTNET_SETTLEMENT_PK    // 0x-prefixed 32-byte hex; funded with tBNB for gas
 *        BSC_TESTNET_PAYER_PK         // 0x-prefixed 32-byte hex; funded with TEST_USDT
 *        BSC_TESTNET_RECIPIENT        // 0x merchant address to receive funds
 *
 *   3. Replace each `it.todo(...)` with the actual e2e flow:
 *      issue challenge via Mppx.create handler → build credential via
 *      `@bnb-chain/mpp/client` → verify via `handler.verifyCredential`
 *      → assert receipt fields + on-chain Transfer event.
 *
 *   4. Run only the live project:
 *        pnpm test -- --project live
 *      (the `--` is REQUIRED: without it some pnpm versions consume
 *      `--project` as their own arg and fail with "Unknown option")
 *
 * Tests are intentionally split per credential type to keep failures
 * isolated and rerunnable. Run sequentially (not parallel) — each
 * settlement consumes nonces / balance.
 */

import { describe, it } from 'vitest'

describe('BSC Testnet live e2e — permit2', () => {
  it.todo('Permit2 single-permit settlement succeeds and emits Transfer')
  it.todo('Permit2 batch-permit (splits) succeeds and emits 1+N Transfer events')
  it.todo('Permit2 with expired deadline reverts in simulate; slot released')
  it.todo('Permit2 nonce replay returns REPLAY on second attempt')
})

describe('BSC Testnet live e2e — transaction', () => {
  it.todo('Transaction credential settles via sendRawTransaction; receipt success')
  it.todo(
    'Same tx broadcast twice: second attempt hits "already known" path, succeeds via receipt lookup',
  )
  it.todo('Reverted tx → markRejected + REJECTED on retry')
})

describe('BSC Testnet live e2e — hash', () => {
  it.todo('Hash credential validates an existing on-chain transfer')
  it.todo('Hash credential with wrong recipient → markRejected')
  it.todo('Hash credential with insufficient confirmations → release + INSUFFICIENT')
})

describe('BSC Testnet live e2e — Payment-Receipt header', () => {
  it.todo('Full Mppx.create HTTP route → withReceipt() header decodes to draft §7.6 fields')
})
