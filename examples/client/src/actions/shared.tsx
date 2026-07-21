/**
 * Shared building blocks for the per-action step modules.
 *
 * The demo flow's step actions (fetch/issue challenge, build credential,
 * local verify, build receipt, submit) each live in their own file under
 * `src/actions/`. The constants, helpers, panel factory and result type
 * that more than one of them need live here so they're defined once.
 */

import { chargeFromDecimal } from '@bnb-chain/mpp'
import { type Address, type Hex, type LocalAccount, type WalletClient } from 'viem'

import { getPresetByKey } from '@/protocol/presets.js'
import { type DemoState, type OutputPanel, type PanelStatus } from '@/state/types'

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const DEMO_SECRET = 'demo-secret-do-not-use-in-prod-at-least-32'

/**
 * Demo-only Permit2 spender — used ONLY by the Failure-cases panel.
 *
 * Permit2 requires the signed `spender` to equal the on-chain msg.sender
 * at settlement (PermitHash._hashWithWitness). A real server publishes its
 * settlement-signer address as `methodDetails.permit2Spender`; the Failure
 * cases panel constructs its throwaway challenges with this fixed
 * placeholder purely so its client-side sign + recover round-trips are
 * internally consistent. It is NOT a real settlement signer and nothing
 * signed against it could settle on-chain.
 */
export const DEMO_PERMIT2_SPENDER = '0x000000000000000000000000000000000000dead' as const

export const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

export const TRANSFER_EVENT_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return '—'
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function safeBigInt(s: string): bigint | null {
  if (s.trim() === '') return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

export function recalcBaseUnits(state: DemoState): string {
  const preset = getPresetByKey(state.chainKey)
  try {
    const out = chargeFromDecimal({ amount: state.amountDecimal, decimals: preset.decimals })
    return out.amount
  } catch {
    return 'invalid'
  }
}

export function parseBaseUnitsOrThrow(state: DemoState): bigint {
  const preset = getPresetByKey(state.chainKey)
  let out: { amount: string }
  try {
    out = chargeFromDecimal({ amount: state.amountDecimal, decimals: preset.decimals })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Amount "${state.amountDecimal}" is not a valid decimal number (${reason}).`, {
      cause,
    })
  }
  const big = BigInt(out.amount)
  if (big <= 0n) {
    throw new Error(`Amount "${state.amountDecimal}" resolves to ${big} — must be > 0.`)
  }
  return big
}

/** Build a LocalAccount adapter that delegates signTypedData to the wallet. */
export function walletSignerFor(
  wallet: { address: Address },
  walletClient: WalletClient,
): LocalAccount {
  return {
    address: wallet.address,
    type: 'local',
    source: 'custom',
    publicKey: '0x' as Hex,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (async (typedData: any) =>
      walletClient.signTypedData({
        account: wallet.address,
        ...typedData,
      })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signMessage: (() => {
      throw new Error('signMessage not used by this credential')
    }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: (() => {
      throw new Error('signTransaction not used by this credential')
    }) as any,
  }
}

/** Pick the signing address for the credential's `source` field. */
export function getSignerAddress(
  _state: DemoState,
  wallet: { address: Address | null } | null,
): Address {
  if (wallet?.address) return wallet.address
  throw new Error('No signer available — connect MetaMask first.')
}

let panelCounter = 0
function nextPanelId(): number {
  return ++panelCounter
}
export function resetPanelCounter(): void {
  panelCounter = 0
}

export function panel(
  title: string,
  body: React.ReactNode,
  status: PanelStatus = 'ok',
): OutputPanel {
  return { id: nextPanelId(), title, status, body }
}

export function errorPanel(title: string, err: unknown): OutputPanel {
  const msg = err instanceof Error ? err.message : String(err)
  return panel(
    title,
    <pre className="whitespace-pre-wrap font-mono text-sm text-red-300">{msg}</pre>,
    'warn',
  )
}

/* -------------------------------------------------------------------------- */
/*  Result type                                                                */
/* -------------------------------------------------------------------------- */

export interface ActionResult {
  patch: Partial<DemoState>
  panel: OutputPanel
  /** When fetchChallengeFromServer syncs form fields, indicate so. */
  formSync?: {
    chainKey?: string
    recipient?: Address
    realm?: string
    amountDecimal?: string
  }
}
