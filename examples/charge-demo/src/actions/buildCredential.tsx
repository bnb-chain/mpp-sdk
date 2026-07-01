/**
 * Step 2: build credential.
 *
 * Dispatches by the selected credential type (hash / transaction /
 * permit2 / authorization) and produces the corresponding credential —
 * broadcasting a real BSC Testnet USDT transfer for `hash`, signing
 * EIP-1559 RLP with an in-page key for `transaction`, or wallet-signing
 * EIP-712 typed data for `permit2` / `authorization`.
 */

import {
  createAuthorizationCredential,
  createHashCredential,
  createPermit2Credential,
  createTransactionCredential,
} from '@bnb-chain/mpp/client'
import { Credential } from 'mppx'
import {
  type Address,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  parseGwei,
} from 'viem'

import { JsonBlock } from '@/components/JsonBlock'
import {
  PERMIT2_ADDRESS,
  canSettleOnChain,
  explorerTxUrl,
  getPresetByKey,
} from '@/protocol/presets.js'
import { type DemoState } from '@/state/types'

import {
  type ActionResult,
  ERC20_TRANSFER_ABI,
  getSignerAddress,
  panel,
  parseBaseUnitsOrThrow,
  walletSignerFor,
} from './shared'

/**
 * Permit2 SignatureTransfer nonces are *unordered* and *single-use*: the
 * contract marks each (owner, nonce) pair spent on first use, so reusing one
 * reverts `InvalidNonce()` (selector 0x756688fe) — which is exactly why a
 * hard-coded nonce settles once and then fails forever. Mint a fresh random
 * 256-bit nonce per credential so every settlement claims an unused slot
 * (unordered nonces need only be unique, not sequential).
 */
function randomPermit2Nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let hex = '0x'
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return BigInt(hex).toString()
}

export interface BuildCredentialContext {
  walletAddress: Address | null
  walletChainId: number | null
  walletClient: WalletClient | null
  publicClient: PublicClient | null
}

export async function buildCredential(
  state: DemoState,
  ctx: BuildCredentialContext,
): Promise<ActionResult> {
  const challenge = state.challenge
  if (!challenge) throw new Error('Issue a challenge first.')
  const preset = getPresetByKey(state.chainKey)
  const amount = parseBaseUnitsOrThrow(state)

  switch (state.credentialType) {
    case 'hash': {
      if (!ctx.walletAddress || !ctx.walletClient || !ctx.publicClient) {
        throw new Error('Wallet must be connected to BSC Testnet to broadcast the settlement tx.')
      }
      if (!canSettleOnChain(state.chainKey, ctx.walletChainId)) {
        throw new Error(
          `Wallet is on chainId=${ctx.walletChainId}, but the selected chain preset is "${state.chainKey}". Switch to BSC Testnet (chainId 97) — the only on-chain-settle-capable preset.`,
        )
      }
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [state.recipient, amount],
      })
      const txHash = await ctx.walletClient.sendTransaction({
        account: ctx.walletAddress,
        chain: ctx.walletClient.chain ?? null,
        to: preset.currency,
        data,
        value: 0n,
      })
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash })
      if (receipt.status !== 'success') {
        // A reverted transfer did NOT pay — refuse to build a hash credential
        // that would look settled. Reference this tx to reconcile.
        throw new Error(
          `Transfer ${txHash} reverted on-chain (status=${receipt.status}) — it did NOT pay; ` +
            `reconcile this tx rather than treating it as settled.`,
        )
      }

      const signer = getSignerAddress(state, { address: ctx.walletAddress })
      const credential = await createHashCredential({
        challenge,
        hash: txHash,
        source: `did:pkh:eip155:${preset.chainId}:${signer}`,
      })
      const explorerLink = explorerTxUrl(preset.chainId, txHash)
      const body = (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Settlement txHash:</div>
          <div className="break-all font-mono text-xs text-emerald-300">{txHash}</div>
          {explorerLink && (
            <div className="text-xs">
              <a
                href={explorerLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                View on explorer ↗
              </a>
            </div>
          )}
          <div className="pt-2 text-xs text-muted-foreground">Decoded credential:</div>
          <JsonBlock value={Credential.deserialize(credential)} />
        </div>
      )
      return {
        patch: { credential, settlementTxHash: txHash },
        panel: panel('Hash credential — real BSC Testnet tx', body),
      }
    }
    case 'transaction': {
      const signerAccount = state.inPageAccount
      if (!signerAccount) {
        throw new Error(
          'Transaction credential requires an in-page key. Click "Generate in-page key" in the configuration panel below.',
        )
      }
      const credential = await createTransactionCredential({
        challenge,
        account: signerAccount,
        chainId: preset.chainId,
        currency: preset.currency,
        recipient: state.recipient,
        amount,
        nonce: 0,
        maxFeePerGas: parseGwei('30'),
        maxPriorityFeePerGas: parseGwei('1'),
        source: `did:pkh:eip155:${preset.chainId}:${signerAccount.address}`,
      })
      const body = (
        <div className="space-y-2">
          <div className="text-xs text-amber-300">
            ⚠ Demo limitation: MetaMask doesn't expose pre-signed unbroadcast EIP-1559 RLP. Using
            in-page random key for this credential type. The signed RLP IS valid for the demo's
            amount/recipient/chainId.
          </div>
          <JsonBlock value={Credential.deserialize(credential)} />
        </div>
      )
      return {
        patch: { credential },
        panel: panel('Transaction credential — in-page-key signed RLP', body, 'warn'),
      }
    }
    case 'permit2': {
      if (!ctx.walletAddress || !ctx.walletClient) {
        throw new Error('Permit2 needs a real signer — connect MetaMask first.')
      }
      const walletSigner = walletSignerFor({ address: ctx.walletAddress }, ctx.walletClient)
      // Permit2 contract is taken from the challenge (wire is the source of
      // truth — the SDK asserts opts.permit2Address equals the wire value
      // and signs the EIP-712 domain with it, so forks / mirror Permit2
      // deployments work). Canonical constant is only a fallback.
      const permit2Address =
        (challenge.request as { methodDetails?: { permit2Address?: Address } }).methodDetails
          ?.permit2Address ?? PERMIT2_ADDRESS
      const credential = await createPermit2Credential({
        challenge,
        account: walletSigner,
        chainId: preset.chainId,
        permit2Address,
        currency: preset.currency,
        recipient: state.recipient,
        amount,
        nonce: randomPermit2Nonce(),
        deadline: String(Math.floor(Date.now() / 1000) + 600),
        ...(state.splits.length > 0 && {
          splits: state.splits.map((s) => ({ recipient: s.recipient, amount: s.amount })),
        }),
      })
      const body = <JsonBlock value={Credential.deserialize(credential)} />
      return {
        patch: { credential },
        panel: panel('Permit2 credential — real wallet-signed EIP-712', body),
      }
    }
    case 'authorization': {
      if (!preset.eip712) {
        throw new Error(
          `chain="${state.chainKey}" / token="${preset.token}" has no curated EIP-3009 domain — the authorization credential is not available in this demo (BSC Testnet USDT is a plain BEP-20).`,
        )
      }
      if (!ctx.walletAddress || !ctx.walletClient) {
        throw new Error('Authorization needs a real signer — connect MetaMask first.')
      }
      const walletSigner = walletSignerFor({ address: ctx.walletAddress }, ctx.walletClient)
      const credential = await createAuthorizationCredential({
        challenge,
        account: walletSigner,
        chainId: preset.chainId,
        currency: preset.currency,
        recipient: state.recipient,
        amount,
        eip712: preset.eip712,
      })
      const body = <JsonBlock value={Credential.deserialize(credential)} />
      return {
        patch: { credential },
        panel: panel('Authorization credential — real wallet-signed EIP-3009', body),
      }
    }
  }
}
