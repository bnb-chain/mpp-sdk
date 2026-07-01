/**
 * client-demo (high-level) — pay any MPP `402` endpoint with ONE call.
 *
 * Same buyer as `pay.ts`, but instead of hand-picking a credential type and
 * driving the build loop yourself, this hands the whole thing to the SDK's
 * high-level `pay(url, { wallet, policy })` (ADR-0003 Phase 1):
 *
 *   - it fetches the 402 and derives the offered routes from the challenge,
 *   - FILTERS them by your `policy` (hard constraints) and RANKS by `mode`,
 *   - builds + submits the chosen credential, and returns the result.
 *
 * You express an INTENT ("prefer gasless, U only, allow one approve"), not a
 * wire. No acceptable route → `NoAcceptableMethodError` (nothing signed or
 * sent); a server that rejects the retry → `PaymentRejectedError` (you may
 * already have signed/broadcast, so reconcile before retrying).
 *
 * Contrast with `pay.ts`: there the chain is read FROM the challenge. Here you
 * pre-commit the wallet to a chain (`CHAIN_ID`, default BSC Testnet) and
 * `pay()` REFUSES if the challenge is for a different chain — pass
 * `allowChainMismatch` to override. That refusal is the fail-closed contract,
 * not a limitation: reading allowance / approving / transferring on the wrong
 * chain is a footgun.
 *
 * Usage:
 *   pnpm --filter @bnb-chain/mpp-example-client-demo start:pay [url]
 *
 *   url  defaults to http://localhost:3001/api/premium (examples/merchant-demo)
 *
 * Env (see .env.example):
 *   PAYER_PRIVATE_KEY  REQUIRED — testnet key holding tBNB (gas) + the token
 *   RPC_URL            optional RPC override
 *   CHAIN_ID           optional — the chain the wallet is on (default 97, BSC Testnet)
 *   PAY_MODE           optional — auto | prefer-gasless | require-gasless | prefer-direct | manual
 */

import { deserializeEvmReceipt } from '@bnb-chain/mpp'
import {
  NoAcceptableMethodError,
  type PayMode,
  type PayPolicy,
  PaymentRejectedError,
  pay,
} from '@bnb-chain/mpp/client'
import { http, createPublicClient, createWalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  base,
  baseSepolia,
  bsc,
  bscTestnet,
  type Chain,
  mainnet,
  opBNB,
  opBNBTestnet,
  sepolia,
} from 'viem/chains'

import { EIP3009_DOMAINS } from './eip3009-domains.js'

/* ── CLI / env ──────────────────────────────────────────────────────────── */

const URL_ARG = process.argv[2] ?? 'http://localhost:3001/api/premium'

const payerKeyRaw = process.env.PAYER_PRIVATE_KEY
if (!payerKeyRaw) {
  console.error('Missing PAYER_PRIVATE_KEY — copy .env.example to .env and fill it in')
  process.exit(1)
}
const payer = privateKeyToAccount(
  (payerKeyRaw.startsWith('0x') ? payerKeyRaw : `0x${payerKeyRaw}`) as `0x${string}`,
)

/* ── Wallet: pre-committed to ONE chain (unlike pay.ts) ─────────────────── */

const KNOWN_CHAINS: readonly Chain[] = [
  bscTestnet,
  bsc,
  opBNB,
  opBNBTestnet,
  sepolia,
  mainnet,
  base,
  baseSepolia,
]
const CHAIN_ID = Number(process.env.CHAIN_ID ?? bscTestnet.id)
const chain = KNOWN_CHAINS.find((c) => c.id === CHAIN_ID)
if (!chain) throw new Error(`CHAIN_ID ${CHAIN_ID} is not in this demo's chain map`)

const transport = http(process.env.RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account: payer, chain, transport })

/* ── Policy: the INTENT, not a credential type ──────────────────────────── */

const mode = (process.env.PAY_MODE ?? 'prefer-gasless') as PayMode
const policy: PayPolicy = {
  mode,
  allowApproval: true, // permit the one-time Permit2 approve if a route needs it
}

console.log(`paying ${URL_ARG}`)
console.log(`  wallet ${payer.address} on ${chain.name} (${chain.id})`)
console.log(`  policy: mode=${mode}, allowApproval=true`)

/* ── One call: fetch → derive → select → build → retry ──────────────────── */

try {
  const { response, route, receiptHeader } = await pay(URL_ARG, {
    wallet: { account: payer, publicClient, walletClient },
    policy,
    eip712Domains: EIP3009_DOMAINS,
  })

  console.log(`\n✔ paid via ${route.id} (gasless=${route.gasless}, trust=${route.trust})`)
  console.log(`✔ HTTP ${response.status} — content unlocked:\n`)
  console.log(JSON.stringify(await response.json(), null, 2))

  if (receiptHeader) {
    const receipt = deserializeEvmReceipt(receiptHeader)
    console.log(`\n✔ Payment-Receipt (draft §7.6):`)
    console.log(`  status:      ${receipt.status}`)
    console.log(`  reference:   ${receipt.reference} (settlement / transfer tx)`)
    console.log(`  challengeId: ${receipt.challengeId}`)
    console.log(`  chainId:     ${receipt.chainId}`)
    const explorer = chain.blockExplorers?.default.url
    if (explorer) console.log(`  explorer:    ${explorer}/tx/${receipt.reference}`)
  } else {
    console.log(`\n(no Payment-Receipt header on the response)`)
  }
} catch (err) {
  // The two fail-closed errors are the whole point — surface them clearly.
  if (err instanceof NoAcceptableMethodError) {
    console.error(`\n✗ no route satisfied the policy — nothing was signed or sent:`)
    for (const r of err.rejected) console.error(`    ${r.id}: ${r.reason}`)
    process.exit(2)
  }
  if (err instanceof PaymentRejectedError) {
    console.error(`\n✗ the server rejected the ${err.route.id} payment (HTTP ${err.status}).`)
    console.error(
      `  a credential may already have been signed/broadcast — reconcile before retrying.`,
    )
    if (err.body) console.error(`  body: ${err.body}`)
    process.exit(3)
  }
  throw err
}
