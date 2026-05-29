// Test runtime mode — opt in via VITE_NODE_ENV env var.
//   'unit'         pure units, no external dependencies
//   'testnet'      integration / live tests targeting BSC + opBNB testnets
//   'mainnet-read' read-only checks against mainnet (no broadcast)
export const nodeEnv: 'unit' | 'testnet' | 'mainnet-read' =
  (process.env.VITE_NODE_ENV as 'unit' | 'testnet' | 'mainnet-read' | undefined) ?? 'testnet'
