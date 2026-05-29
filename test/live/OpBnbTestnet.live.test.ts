/**
 * opBNB Testnet live e2e (spec §15 DoD).
 *
 * Status: SCAFFOLD ONLY — see BscTestnet.live.test.ts for full setup
 * instructions. The structure mirrors BSC Testnet because the curated
 * matrix shares preset names; only chainId / RPC URL differ.
 *
 * To enable:
 *   - Pin an opBNB Testnet TEST_USDT contract in src/server/curated.ts
 *     (the matrix entry already exists at chain 'opbnb-testnet'; only
 *     the address sentinel needs the real verified contract).
 *   - Provide env:
 *       OPBNB_TESTNET_RPC_URL
 *       OPBNB_TESTNET_SETTLEMENT_PK
 *       OPBNB_TESTNET_PAYER_PK
 *       OPBNB_TESTNET_RECIPIENT
 *   - Replace `it.todo` with actual flows matching BscTestnet structure.
 *   - Run: `pnpm test -- --project live` (the `--` is REQUIRED — some pnpm
 *     versions consume `--project` as their own arg and fail otherwise).
 */

import { describe, it } from 'vitest'

describe('opBNB Testnet live e2e — permit2', () => {
  it.todo('Permit2 single-permit settlement succeeds and emits Transfer')
  it.todo('Permit2 batch-permit (splits) succeeds and emits 1+N Transfer events')
})

describe('opBNB Testnet live e2e — transaction', () => {
  it.todo('Transaction credential settles via sendRawTransaction; receipt success')
})

describe('opBNB Testnet live e2e — hash', () => {
  it.todo('Hash credential validates an existing on-chain transfer')
})

describe('opBNB Testnet live e2e — Payment-Receipt header', () => {
  it.todo('Full Mppx.create HTTP route → withReceipt() header decodes to draft §7.6 fields')
})
