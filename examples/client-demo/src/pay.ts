/**
 * client-demo — pay any MPP `402 Payment Required` endpoint from Node.
 *
 * This is the machine side of the protocol: the exact loop an AI agent,
 * a script, or a backend service runs to buy an API response —
 *
 *   1. GET the resource              → 402 + WWW-Authenticate challenge
 *   2. parse the challenge           → amount / token / chain / accepted types
 *   3. build ONE credential          → @bnb-chain/mpp/client constructor
 *   4. GET again w/ Authorization    → 200 + content + Payment-Receipt
 *
 * Usage:
 *   pnpm --filter @bnb-chain/mpp-example-client-demo start [url] [type]
 *
 *   url   defaults to http://localhost:3001/api/premium (examples/merchant-demo)
 *   type  optional: permit2 | transaction | hash | authorization
 *         (default: the first type the server advertises that we can build)
 *
 * Env (see .env.example):
 *   PAYER_PRIVATE_KEY   REQUIRED — testnet key holding tBNB (gas) + the token
 *   RPC_URL             optional RPC override
 *
 * What each type costs the payer on BSC Testnet:
 *   permit2        sign typed data (no gas at pay time; one-time Permit2
 *                  approve costs gas — this script sends it automatically)
 *   transaction    pre-sign an EIP-1559 transfer; the SERVER broadcasts it
 *                  (gas comes from your balance when it lands)
 *   hash           broadcast the transfer yourself, then reference its hash
 *   authorization  sign EIP-3009 typed data (no gas; token must support it)
 */

import { deserializeEvmReceipt } from '@bnb-chain/mpp'
import {
  createAuthorizationCredential,
  createHashCredential,
  createPermit2Credential,
  createTransactionCredential,
} from '@bnb-chain/mpp/client'
import { Challenge } from 'mppx'
import {
  http,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  maxUint256,
} from 'viem'
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

/* ── CLI / env ──────────────────────────────────────────────────────────── */

const URL_ARG = process.argv[2] ?? 'http://localhost:3001/api/premium'
const TYPE_ARG = process.argv[3] // optional explicit credential type

const payerKeyRaw = process.env.PAYER_PRIVATE_KEY
if (!payerKeyRaw) {
  console.error('Missing PAYER_PRIVATE_KEY — copy .env.example to .env and fill it in')
  process.exit(1)
}
const payer = privateKeyToAccount(
  (payerKeyRaw.startsWith('0x') ? payerKeyRaw : `0x${payerKeyRaw}`) as `0x${string}`,
)

/** Resolve the viem chain for the challenge's chainId (no hard-coded chain). */
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

/**
 * EIP-3009 needs the token's EIP-712 domain, which is a property of the
 * token CONTRACT and is not on the wire. A real client configures it per
 * token; this demo knows the SDK's probed anchors (see README "Tokens").
 */
const EIP3009_DOMAINS: Record<string, { name: string; version: string }> = {
  '11155111:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': { name: 'USDC', version: '2' },
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USD Coin', version: '2' },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2' },
  '56:0xc5f0f7b66764f6ec8c8dff7ba683102295e16409': { name: 'First Digital USD', version: '1' },
  '56:0xce24439f2d9c6a2289f741120fe202248b666666': { name: 'United Stables', version: '1' },
}

/* ── 1. Fetch the 402 challenge ─────────────────────────────────────────── */

console.log(`[1/4] GET ${URL_ARG}`)
const probe = await fetch(URL_ARG)
if (probe.status !== 402) {
  console.log(`      not payment-gated (HTTP ${probe.status}):`)
  console.log(await probe.text())
  process.exit(probe.ok ? 0 : 1)
}
const wwwAuthenticate = probe.headers.get('WWW-Authenticate')
if (!wwwAuthenticate) throw new Error('402 without a WWW-Authenticate header')
const challenge = Challenge.deserialize(wwwAuthenticate)

/* ── 2. Read the offer off the challenge ────────────────────────────────── */

const request = challenge.request as {
  amount: string
  currency: `0x${string}`
  recipient: `0x${string}`
  description?: string
  methodDetails: {
    chainId: number
    permit2Address: `0x${string}`
    permit2Spender?: `0x${string}`
    credentialTypes?: string[]
  }
}
const { amount, currency, recipient } = request
const { chainId, permit2Address } = request.methodDetails
// Per draft §11.2, an absent credentialTypes means the payer-funded set.
const accepted = request.methodDetails.credentialTypes ?? ['transaction', 'hash']

const chain = KNOWN_CHAINS.find((c) => c.id === chainId)
if (!chain) throw new Error(`challenge is for chainId ${chainId} — not in this demo's chain map`)

const transport = http(process.env.RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({ account: payer, chain, transport })

// Decimals/symbol are token-contract properties, not wire fields — read
// them once so the log shows a human amount next to the base units.
const [symbol, decimals] = await Promise.all([
  publicClient.readContract({ address: currency, abi: erc20Abi, functionName: 'symbol' }),
  publicClient.readContract({ address: currency, abi: erc20Abi, functionName: 'decimals' }),
]).catch(() => [undefined, undefined] as const)
const human =
  decimals !== undefined ? `${formatUnits(BigInt(amount), decimals)} ${symbol}` : 'see base units'

console.log(`[2/4] challenge: pay ${human} (${amount} base units of ${currency})`)
console.log(`      chain ${chain.name} (${chainId}) → recipient ${recipient}`)
console.log(`      accepted credential types (server preference): ${accepted.join(', ')}`)

/* ── 3. Build one credential ────────────────────────────────────────────── */

type Builder = () => Promise<string>

const builders: Record<string, Builder> = {
  /** Sign Permit2 typed data; the server settles. Auto-approves Permit2 once. */
  async permit2() {
    const allowance = await publicClient.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [payer.address, permit2Address],
    })
    if (allowance < BigInt(amount)) {
      console.log(`      permit2: one-time approve(Permit2, max) — sending…`)
      const approveTx = await walletClient.writeContract({
        address: currency,
        abi: erc20Abi,
        functionName: 'approve',
        args: [permit2Address, maxUint256],
      })
      await publicClient.waitForTransactionReceipt({ hash: approveTx })
      console.log(`      approve mined: ${approveTx}`)
    }
    // Permit2 nonces are unordered + single-use: a random 256-bit value is
    // correct (uniqueness matters, sequence doesn't).
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const nonce = BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`)
    return createPermit2Credential({
      challenge,
      account: payer,
      chainId,
      permit2Address, // from the challenge — never a hard-coded constant
      currency,
      recipient,
      amount,
      nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    })
  },

  /** Pre-sign a full EIP-1559 transfer; the server broadcasts it. */
  async transaction() {
    const [nonce, fees] = await Promise.all([
      publicClient.getTransactionCount({ address: payer.address, blockTag: 'pending' }),
      publicClient.estimateFeesPerGas().catch(async () => {
        // Chains without a usable 1559 fee oracle: fall back to gasPrice.
        const gasPrice = await publicClient.getGasPrice()
        return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
      }),
    ])
    return createTransactionCredential({
      challenge,
      account: payer,
      chainId,
      currency,
      recipient,
      amount,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
  },

  /** Broadcast the transfer ourselves, then reference its hash. */
  async hash() {
    console.log(`      hash: broadcasting transfer(${recipient}, ${amount})…`)
    const txHash = await walletClient.writeContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, BigInt(amount)],
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    console.log(`      transfer mined: ${txHash}`)
    return createHashCredential({ challenge, hash: txHash })
  },

  /** Sign EIP-3009 transferWithAuthorization typed data; the server settles. */
  async authorization() {
    const eip712 = EIP3009_DOMAINS[`${chainId}:${currency.toLowerCase()}`]
    if (!eip712) {
      throw new Error(
        `authorization: no EIP-712 domain known for ${currency} on chain ${chainId} ` +
          `(add it to EIP3009_DOMAINS — it is a property of the token contract)`,
      )
    }
    return createAuthorizationCredential({
      challenge,
      account: payer,
      chainId,
      currency,
      recipient,
      amount,
      eip712,
    })
  },
}

const credentialType =
  TYPE_ARG ?? accepted.find((t) => t in builders) ?? raise('no buildable credential type')
if (!accepted.includes(credentialType))
  throw new Error(`server does not accept '${credentialType}' (accepted: ${accepted.join(', ')})`)
const builder = builders[credentialType] ?? raise(`unknown credential type '${credentialType}'`)

console.log(`[3/4] building '${credentialType}' credential as ${payer.address}`)
const credential = await builder()

/* ── 4. Retry with Authorization → content + receipt ────────────────────── */

console.log(`[4/4] GET ${URL_ARG} with Authorization: Payment …`)
// The constructor returns the COMPLETE header value ('Payment ' included).
const paid = await fetch(URL_ARG, { headers: { Authorization: credential } })

if (!paid.ok) {
  console.error(`      payment rejected (HTTP ${paid.status}):`)
  console.error(await paid.text())
  process.exit(1)
}

console.log(`\n✔ HTTP ${paid.status} — content unlocked:\n`)
console.log(JSON.stringify(await paid.json(), null, 2))

const receiptHeader = paid.headers.get('Payment-Receipt')
if (receiptHeader) {
  const receipt = deserializeEvmReceipt(receiptHeader)
  console.log(`\n✔ Payment-Receipt (draft §7.6):`)
  console.log(`  status:      ${receipt.status}`)
  console.log(`  reference:   ${receipt.reference} (settlement / transfer tx)`)
  console.log(`  challengeId: ${receipt.challengeId}`)
  console.log(`  chainId:     ${receipt.chainId}`)
  const explorer = chain.blockExplorers?.default.url
  if (explorer) console.log(`  explorer:    ${explorer}/tx/${receipt.reference}`)
}

function raise(message: string): never {
  throw new Error(message)
}
