import { type Address, type Hex, type LocalAccount, type WalletClient } from 'viem'

import { type DemoState, type OutputPanel, type PanelStatus } from '@/state/types'

/** Adapt an injected viem wallet to the signer accepted by the B402 client. */
export function walletSignerFor(address: Address, walletClient: WalletClient): LocalAccount {
  return {
    address,
    type: 'local',
    source: 'custom',
    publicKey: '0x' as Hex,
    // The wallet owns user confirmation; the demo never handles a private key.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (async (typedData: any) =>
      walletClient.signTypedData({ account: address, ...typedData })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signMessage: (() => {
      throw new Error('signMessage is not used by B402 charge credentials')
    }) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransaction: (() => {
      throw new Error('signTransaction is not used by B402 charge credentials')
    }) as any,
  }
}

let panelCounter = 0

export function panel(
  title: string,
  body: React.ReactNode,
  status: PanelStatus = 'ok',
): OutputPanel {
  panelCounter += 1
  return { id: panelCounter, title, status, body }
}

export function errorPanel(title: string, error: unknown): OutputPanel {
  const message = error instanceof Error ? error.message : String(error)
  return panel(
    title,
    <pre className="whitespace-pre-wrap font-mono text-sm text-red-300">{message}</pre>,
    'warn',
  )
}

export interface ActionResult {
  patch: Partial<DemoState>
  panel: OutputPanel
}
