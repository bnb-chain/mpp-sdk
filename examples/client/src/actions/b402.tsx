/** Four-step browser walkthrough shared by both MPP-native B402 paths. */

import {
  type B402ChargeCredentialPayload,
  type B402ChargeRequest,
  type Eip3009PaymentPayload,
  isEip3009PaymentPayload,
  isPermit2PaymentPayload,
  type PaymentRequirements,
  type Permit2PaymentPayload,
  recoverEip3009Payer,
  recoverPermit2ExactPayer,
} from '@bnb-chain/mpp/b402'
import {
  B402_PERMIT2_ADDRESS,
  CURATED_B402_SPENDERS,
  charge as b402Charge,
} from '@bnb-chain/mpp/b402/client'
import { Challenge, Credential, evm, Receipt } from 'mppx'
import {
  erc20Abi,
  getAddress,
  maxUint256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'

import { JsonBlock } from '@/components/JsonBlock'
import { explorerTxUrl } from '@/protocol/presets.js'
import { type B402Path, type DemoState } from '@/state/types'

import { type ActionResult, panel, walletSignerFor } from './shared'

const ENDPOINTS: Readonly<Record<B402Path, string>> = {
  eip3009: import.meta.env.VITE_B402_EIP3009_ENDPOINT ?? '/api/b402/eip3009',
  'permit2-exact': import.meta.env.VITE_B402_PERMIT2_ENDPOINT ?? '/api/b402/permit2',
}

export interface BuildCredentialContext {
  walletAddress: Address | null
  walletChainId: number | null
  walletClient: WalletClient | null
  publicClient: PublicClient | null
}

export function b402Endpoint(path: B402Path): string {
  return ENDPOINTS[path]
}

export async function fetchB402Challenge(state: DemoState): Promise<ActionResult> {
  const endpoint = b402Endpoint(state.path)
  const response = await fetch(endpoint)
  if (response.status !== 402) {
    throw new Error(`Expected HTTP 402 from ${endpoint}, got ${response.status}`)
  }
  const header = response.headers.get('WWW-Authenticate')
  if (!header) throw new Error('B402 route returned no WWW-Authenticate challenge')
  const challenge = Challenge.deserialize(header)
  if (challenge.method !== 'b402' || challenge.intent !== 'charge') {
    throw new Error(`Expected b402/charge, got ${challenge.method}/${challenge.intent}`)
  }
  const request = challenge.request as B402ChargeRequest
  if (request.methodDetails.assetTransferMethod !== state.path) {
    throw new Error(
      `Expected ${state.path}, got ${request.methodDetails.assetTransferMethod} from ${endpoint}`,
    )
  }

  return {
    panel: panel(`Challenge · ${state.path}`, <JsonBlock value={challenge} />),
    patch: { challenge },
  }
}

export async function buildB402Credential(
  state: DemoState,
  context: BuildCredentialContext,
): Promise<ActionResult> {
  if (!state.challenge) throw new Error('Fetch the B402 Challenge first')
  if (!context.walletAddress || !context.walletClient) {
    throw new Error('Connect a wallet before signing a B402 credential')
  }
  const request = state.challenge.request as B402ChargeRequest
  const network = request.methodDetails.network
  const chainId = Number(network.slice('eip155:'.length))
  if (context.walletChainId !== chainId) {
    throw new Error(`Switch the wallet to chain ${chainId}; the Challenge uses ${network}`)
  }

  let allowance: bigint | undefined
  let approvalHash: Hex | undefined
  if (state.path === 'permit2-exact') {
    if (!context.publicClient) throw new Error('No public RPC client for the connected chain')
    allowance = await readPermit2Allowance(context, request)
    if (allowance < BigInt(request.amount)) {
      approvalHash = await context.walletClient.writeContract({
        abi: erc20Abi,
        account: context.walletAddress,
        address: request.currency,
        args: [B402_PERMIT2_ADDRESS, maxUint256],
        chain: context.walletClient.chain ?? null,
        functionName: 'approve',
      })
      const receipt = await context.publicClient.waitForTransactionReceipt({ hash: approvalHash })
      if (receipt.status !== 'success') throw new Error('Permit2 approval transaction reverted')
      allowance = await readPermit2Allowance(context, request)
    }
  }

  const method = b402Charge({
    account: walletSignerFor(context.walletAddress, context.walletClient),
    allowedCurrencies: [{ address: request.currency, network }],
    allowedNetworks: [network],
    maxAtomicAmount: request.amount,
    methods: [state.path],
    ...(state.path === 'permit2-exact'
      ? {
          permit2Allowance: () => allowance!,
          trustedSpenders: {
            [network]: CURATED_B402_SPENDERS[network]
              ? [CURATED_B402_SPENDERS[network]!.exact]
              : [],
          },
        }
      : {}),
  })
  const credential = await method.createCredential({ challenge: state.challenge as never })

  return {
    panel: panel(
      `Credential · ${state.path}`,
      <div className="space-y-2">
        {approvalHash && <div className="break-all text-xs">Permit2 approval: {approvalHash}</div>}
        <JsonBlock value={Credential.deserialize(credential)} />
      </div>,
    ),
    patch: { credential },
  }
}

export async function verifyB402Local(state: DemoState): Promise<ActionResult> {
  if (!state.challenge || !state.credential) throw new Error('Build the credential first')
  const credential = Credential.deserialize<B402ChargeCredentialPayload>(state.credential)
  const request = state.challenge.request as B402ChargeRequest
  if (credential.payload.type !== state.path) {
    throw new Error(`Expected ${state.path} payload, got ${credential.payload.type}`)
  }
  const requirements = toRequirements(request)
  const expectedNonce = evm.Types.challengeHash(state.challenge)
  let recovered: Address

  if (credential.payload.type === 'eip3009') {
    const payment: Eip3009PaymentPayload = {
      accepted: requirements,
      payload: {
        authorization: credential.payload.authorization,
        signature: credential.payload.signature,
      },
      x402Version: 2,
    }
    if (!isEip3009PaymentPayload(payment)) throw new Error('Malformed EIP-3009 payment')
    if (payment.payload.authorization.nonce !== expectedNonce) {
      throw new Error('EIP-3009 nonce is not bound to this MPP Challenge')
    }
    recovered = getAddress(await recoverEip3009Payer(payment))
    if (recovered !== getAddress(payment.payload.authorization.from)) {
      throw new Error('EIP-3009 signer does not match authorization.from')
    }
  } else {
    const payment: Permit2PaymentPayload = {
      accepted: requirements,
      payload: {
        permit2Authorization: credential.payload.permit2Authorization,
        signature: credential.payload.signature,
      },
      x402Version: 2,
    }
    if (!isPermit2PaymentPayload(payment)) throw new Error('Malformed Permit2 Exact payment')
    if (payment.payload.permit2Authorization.nonce !== BigInt(expectedNonce).toString()) {
      throw new Error('Permit2 nonce is not bound to this MPP Challenge')
    }
    recovered = getAddress(await recoverPermit2ExactPayer(payment))
    if (recovered !== getAddress(payment.payload.permit2Authorization.from)) {
      throw new Error('Permit2 signer does not match authorization.from')
    }
  }

  return {
    panel: panel(
      `Local verification · ${state.path}`,
      <JsonBlock value={{ challengeBound: true, recovered, transferMethod: state.path }} />,
    ),
    patch: { recovered },
  }
}

export async function submitB402Credential(state: DemoState): Promise<ActionResult> {
  if (!state.challenge || !state.credential) throw new Error('Build the credential first')
  const endpoint = b402Endpoint(state.path)
  const response = await fetch(endpoint, {
    headers: { Authorization: state.credential },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `B402 route returned HTTP ${response.status}: ${body.slice(0, 300)}. ` +
        'Reuse/reconcile this exact credential; do not sign a second payment blindly.',
    )
  }
  const receiptHeader = response.headers.get('Payment-Receipt')
  if (!receiptHeader) throw new Error('Paid response has no Payment-Receipt header')
  const receipt = Receipt.fromResponse(response)
  const request = state.challenge.request as B402ChargeRequest
  const chainId = Number(request.methodDetails.network.slice('eip155:'.length))
  const transaction = /^0x[0-9a-fA-F]{64}$/.test(receipt.reference)
    ? (receipt.reference as Hex)
    : null
  const explorer = transaction ? explorerTxUrl(chainId, transaction) : null

  return {
    panel: panel(
      `Settled · ${state.path}`,
      <div className="space-y-2">
        {explorer && (
          <a
            className="text-primary hover:underline"
            href={explorer}
            rel="noreferrer"
            target="_blank"
          >
            View settlement transaction ↗
          </a>
        )}
        <JsonBlock value={receipt} />
      </div>,
    ),
    patch: { receiptHeader, settlementTxHash: transaction },
  }
}

async function readPermit2Allowance(
  context: BuildCredentialContext,
  request: B402ChargeRequest,
): Promise<bigint> {
  if (!context.walletAddress || !context.publicClient) {
    throw new Error('Permit2 allowance requires a wallet address and public RPC client')
  }
  return context.publicClient.readContract({
    abi: erc20Abi,
    address: request.currency,
    args: [context.walletAddress, B402_PERMIT2_ADDRESS],
    functionName: 'allowance',
  })
}

function toRequirements(request: B402ChargeRequest): PaymentRequirements {
  return {
    amount: request.amount,
    asset: getAddress(request.currency),
    extra: {
      assetTransferMethod: request.methodDetails.assetTransferMethod,
      name: request.methodDetails.eip712.name,
      signerAddress: getAddress(request.methodDetails.signerAddress),
      ...(request.methodDetails.spenderAddress
        ? { spenderAddress: getAddress(request.methodDetails.spenderAddress) }
        : {}),
      version: request.methodDetails.eip712.version,
    },
    maxTimeoutSeconds: request.methodDetails.maxTimeoutSeconds,
    network: request.methodDetails.network,
    payTo: getAddress(request.recipient),
    scheme: 'exact',
  }
}
