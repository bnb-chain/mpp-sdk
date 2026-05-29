/**
 * viem account / wallet type re-exports.
 *
 * Centralises which viem types this SDK depends on so callers can import
 * from `@bnb-chain/mpp/server` without pulling in viem directly. Add
 * helpers (e.g. `resolveAccount`) here if/when needed; this module ships
 * re-exports only.
 */

export type {
  Account,
  HDAccount,
  JsonRpcAccount,
  LocalAccount,
  PrivateKeyAccount,
  WalletClient,
} from 'viem'
export { createWalletClient, http } from 'viem'
export { privateKeyToAccount } from 'viem/accounts'
