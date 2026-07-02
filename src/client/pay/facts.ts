/**
 * Fact resolution — the impure inputs `selectRoute` + `buildCredential` need:
 * the chain-consistency guard, on-chain reads (decimals / Permit2 allowance),
 * the `maxAmount` ceiling, the EIP-712 domain lookup, and the wallet capability
 * matrix. Kept out of `routes.ts` so the selection core stays pure.
 */

import { type Address, erc20Abi, parseUnits } from 'viem'

import type { Eip712DomainMap, WalletCapabilities, WalletContext } from './routes.js'

/**
 * The wallet AND the public client must BOTH be on the challenge's chain —
 * otherwise we'd read allowance / approve / transfer on the wrong chain. Check
 * each INDEPENDENTLY: a wallet on the right chain does not excuse a public
 * client (the reader) pointed at another. Two fail-closed rules (unless the
 * caller opts out with `allowChainMismatch`):
 *
 *  1. any client that DECLARES a chain id must match the challenge's, and
 *  2. at least one client must declare a chain id — a fully chain-less pair
 *     cannot be CONFIRMED to be on the right chain, and a mis-pointed RPC would
 *     silently approve/transfer on the wrong one. Refuse rather than guess.
 */
export function assertChainConsistency(
  wallet: WalletContext,
  chainId: number,
  allowMismatch: boolean,
): void {
  if (allowMismatch) return
  const declared = [
    ['wallet', wallet.walletClient.chain?.id],
    ['public', wallet.publicClient.chain?.id],
  ] as const
  for (const [label, id] of declared) {
    if (id !== undefined && id !== chainId) {
      throw new Error(
        `challenge is for chain ${chainId} but the ${label} client is on chain ${id} ` +
          `— point it at chain ${chainId} or pass allowChainMismatch:true to override`,
      )
    }
  }
  if (declared.every(([, id]) => id === undefined)) {
    throw new Error(
      `neither the wallet nor the public client declares a chain id, so pay() cannot confirm ` +
        `they are on the challenge's chain ${chainId} — approving/transferring on a mis-pointed ` +
        `RPC would settle on the wrong chain. Construct the viem clients with an explicit ` +
        `\`chain\`, or pass allowChainMismatch:true to take responsibility.`,
    )
  }
}

export interface ResolvedFacts {
  readonly capabilities: WalletCapabilities
  readonly maxAmountBase?: bigint
  readonly eip712?: { readonly name: string; readonly version: string }
  /**
   * Payer's token balance. `undefined` when unreadable — the affordability
   * pre-check then fails OPEN (an RPC hiccup or nonstandard token must not
   * block a payment the chain would accept; the server re-checks anyway).
   */
  readonly balance?: bigint
}

/**
 * Resolve everything selection + build depend on. `maxAmount` FAILS CLOSED: if a
 * ceiling is set but decimals cannot be read, we refuse rather than pay past an
 * unenforced limit. Token identity is NOT read here — it is the wire `currency`.
 */
export async function resolveFacts(args: {
  readonly wallet: WalletContext
  readonly chainId: number
  readonly currency: Address
  readonly permit2Address: Address
  readonly amountBase: bigint
  readonly maxAmount?: string
  readonly eip712Domains?: Eip712DomainMap
}): Promise<ResolvedFacts> {
  const { wallet, chainId, currency, permit2Address, amountBase } = args
  const { account, publicClient, walletClient } = wallet

  const decimals = await publicClient
    .readContract({ address: currency, abi: erc20Abi, functionName: 'decimals' })
    .catch(() => undefined)
  const allowance = await publicClient
    .readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, permit2Address],
    })
    .catch(() => 0n)
  const balance = await publicClient
    .readContract({
      address: currency,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    .catch(() => undefined)
  // The map key's address part is matched case-insensitively — a checksummed
  // key must not silently miss the (lowercase) wire currency.
  const eip712Key = `${chainId}:${currency.toLowerCase()}`
  const eip712 = args.eip712Domains
    ? Object.entries(args.eip712Domains).find(([k]) => k.toLowerCase() === eip712Key)?.[1]
    : undefined

  let maxAmountBase: bigint | undefined
  if (args.maxAmount !== undefined) {
    if (decimals === undefined) {
      throw new Error(
        `policy.maxAmount is set but token decimals could not be resolved for ${currency} on ` +
          `chain ${chainId} — refusing to pay without enforcing the limit`,
      )
    }
    maxAmountBase = parseUnits(args.maxAmount, decimals)
  }

  const capabilities: WalletCapabilities = {
    canSignTypedData: typeof account.signTypedData === 'function',
    canSignTransaction: typeof account.signTransaction === 'function',
    canBroadcast: typeof walletClient.writeContract === 'function',
    hasPermit2Allowance: allowance >= amountBase,
    knownEip712Domain: eip712 !== undefined,
  }

  return {
    capabilities,
    ...(maxAmountBase !== undefined && { maxAmountBase }),
    ...(eip712 && { eip712 }),
    ...(balance !== undefined && { balance }),
  }
}
