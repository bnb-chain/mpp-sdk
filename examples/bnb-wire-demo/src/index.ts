/**
 * BNB Chain wire-shape inspector — no broadcast.
 *
 * For each curated BNB Chain stablecoin, resolves the deployment via the SDK
 * (`preflightCharge`) and prints the wire shapes a client would see: the
 * challenge request, the accepted `credentialTypes`, the EIP-712 (EIP-3009)
 * domain where applicable, and the receipt field shape. Nothing is signed or
 * broadcast — preflight only does a single read-only `eth_getCode` Permit2
 * probe against the RPC.
 *
 * Run:
 *   pnpm --filter @bnb-chain/mpp-example-bnb-wire-demo start
 *   BSC_RPC_URL=https://your-node pnpm --filter ...-bnb-wire-demo start
 *
 * opBNB tokens are intentionally absent: their stablecoin provenance is not
 * yet verified into the curated matrix (see src/server/curated.ts).
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import {
  type ChargeStore,
  preflightCharge,
  type SupportedChainPreset,
  type SupportedTokenPreset,
} from '@bnb-chain/mpp/server'
import { Store } from 'mppx'
import { privateKeyToAccount } from 'viem/accounts'

const BSC_RPC_URL = process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com'

// Throwaway signer — only so preflight can resolve a settlement signer
// (permit2 / authorization need one). NEVER used to broadcast; the printed
// `permit2Spender` is this address purely for illustration.
const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const

// A shared memory replay store just to keep preflight quiet (a wire inspector
// never verifies). Production uses a durable store — see charge-server.
const store = Store.memory() as ChargeStore

const TOKENS: ReadonlyArray<readonly [SupportedChainPreset, SupportedTokenPreset]> = [
  ['bsc', 'FDUSD'],
  ['bsc', 'U'],
  ['bsc', 'BINANCE_PEG_USDC'],
  ['bsc', 'BINANCE_PEG_USDT'],
  ['bsc', 'BINANCE_PEG_DAI'],
]

console.log(`BNB Chain wire-shape inspector (RPC: ${BSC_RPC_URL})\n`)

for (const [chain, token] of TOKENS) {
  try {
    const resolved = await preflightCharge({
      chain,
      token,
      recipient: RECIPIENT,
      settlementAccount: signer,
      challengeBinding: { mode: 'mppx-managed' },
      store,
      rpcUrl: BSC_RPC_URL,
    })
    const r = resolved._resolved
    const amount = chargeFromDecimal({ amount: '1.0', decimals: r.decimals }).amount
    const request = {
      amount,
      currency: r.currency,
      recipient: RECIPIENT,
      methodDetails: {
        chainId: r.chainId,
        permit2Address: r.permit2Address,
        permit2Spender: signer.address,
        credentialTypes: r.resolvedCredentialTypes,
        decimals: r.decimals,
      },
    }
    console.log(`── ${chain} / ${token} ──`)
    console.log(`  currency:        ${r.currency}`)
    console.log(`  decimals:        ${r.decimals}`)
    console.log(`  chainId:         ${r.chainId}`)
    console.log(`  credentialTypes: ${r.resolvedCredentialTypes.join(', ')}`)
    console.log(
      `  EIP-712 domain:  ${
        r.eip712
          ? `{ name: '${r.eip712.name}', version: '${r.eip712.version}' }  (EIP-3009 authorization)`
          : 'none (no EIP-3009 — permit2 / transaction / hash only)'
      }`,
    )
    console.log(`  wire request:    ${JSON.stringify(request)}`)
    console.log()
  } catch (e) {
    console.log(
      `── ${chain} / ${token} ──  FAILED: ${e instanceof Error ? e.message : String(e)}\n`,
    )
  }
}

console.log('Receipt shape (draft §7.6 — returned in the Payment-Receipt header on 200):')
console.log('  { challengeId, chainId, reference (settlement txHash), externalId? }')
console.log('\nNothing was signed or broadcast — this is a read-only wire inspector.')
