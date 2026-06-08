/**
 * Environment reading + validation for the charge-server example.
 *
 * `loadConfig()` reads the four env vars, runs the exact validation the
 * server requires, and returns a typed config object. It throws on bad
 * config with the same distinct, diagnosable error messages used before
 * the split — a misconfigured .env stays debuggable from the throw alone.
 *
 * Configuration (env vars):
 *   RECIPIENT_ADDRESS         merchant address to receive funds (REQUIRED)
 *   MPP_SECRET_KEY            HMAC secret for mppx-managed challenge
 *                             binding (REQUIRED; `openssl rand -hex 32`)
 *   SETTLEMENT_PRIVATE_KEY    0x-prefixed 32-byte hex private key for the
 *                             server-side settlement signer. Required for
 *                             permit2 (which broadcasts a settlement tx).
 *                             Must hold tBNB (BSC Testnet) for gas.
 *   RPC_URL                   (optional) custom BSC Testnet RPC. Defaults to
 *                             viem's bundled public provider (rate-limited).
 *   PORT                      (optional) HTTP port, default 3000.
 */

import { isAddress, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem/accounts'

export interface ChargeServerConfig {
  /** Validated merchant address that receives funds. */
  recipient: `0x${string}`
  /** HMAC secret for mppx-managed challenge binding. */
  secret: string
  /** Server-side settlement signer (permit2). */
  settlementAccount: PrivateKeyAccount
  /** Optional custom BSC Testnet RPC; undefined → viem's bundled provider. */
  rpcUrl: string | undefined
  /** HTTP port. */
  port: number
}

/**
 * Parse the optional PORT env var into a valid TCP port.
 *
 * Unset / empty → default 3000. Otherwise the value must be an integer in
 * 1..65535; anything else (non-numeric, float, out of range) throws rather
 * than silently degrading to `NaN` and failing deep inside the HTTP server
 * with an opaque message.
 */
function parsePort(raw: string | undefined): number {
  if (!raw) return 3000
  if (!/^\d+$/.test(raw)) {
    throw new Error(`PORT must be a whole number (1..65535). Got "${raw}".`)
  }
  const port = Number.parseInt(raw, 10)
  if (port < 1 || port > 65535) {
    throw new Error(`PORT must be in the range 1..65535. Got ${port}.`)
  }
  return port
}

export function loadConfig(): ChargeServerConfig {
  const RECIPIENT_RAW = process.env.RECIPIENT_ADDRESS
  const SECRET = process.env.MPP_SECRET_KEY
  const SETTLEMENT_PK_RAW = process.env.SETTLEMENT_PRIVATE_KEY
  const PORT = parsePort(process.env.PORT)

  // Address validation — three independent failure modes, each with its
  // own error message so a misconfigured .env is diagnosable from the
  // throw alone:
  //
  //   1. unset / empty            — env var missing or blank
  //   2. wrong hex shape          — fails `isAddress(strict:false)` (length
  //                                  or non-hex characters)
  //   3. zero address             — burn-address sentinel rejected explicitly
  //
  // We deliberately pass `strict: false` to `isAddress` (skip EIP-55
  // checksum-case validation). viem's default `strict: true` rejects
  // mixed-case addresses whose checksum case doesn't match the EIP-55
  // algorithm. For a local example the friction of "paste address → server
  // won't start with a single-error message that doesn't say checksum" is
  // worse than the safety net of catching one-character typos via case
  // check. Real merchant deployments validate addresses out-of-band before
  // they ever land in env. The `zeroAddress` check below still catches the
  // most common typo (blank value) so the burn-address footgun stays
  // closed.
  if (!RECIPIENT_RAW) {
    throw new Error(
      'RECIPIENT_ADDRESS env var is not set. Edit .env (copied from .env.example) ' +
        'and put your merchant address there.',
    )
  }
  if (!isAddress(RECIPIENT_RAW, { strict: false })) {
    throw new Error(
      'RECIPIENT_ADDRESS must be a 20-byte hex EVM address: "0x" + 40 hex characters. ' +
        `Got "${RECIPIENT_RAW.slice(0, 6)}…${RECIPIENT_RAW.slice(-4)}" (${RECIPIENT_RAW.length} chars). ` +
        'Check for stray quotes / spaces / line breaks in the .env value.',
    )
  }
  if (RECIPIENT_RAW.toLowerCase() === zeroAddress) {
    throw new Error(
      'RECIPIENT_ADDRESS is the zero address (0x000…000). The example refuses ' +
        'to start with the burn address as the payment recipient.',
    )
  }
  const RECIPIENT = RECIPIENT_RAW
  if (!SECRET) {
    throw new Error(
      'MPP_SECRET_KEY env var must be set (HMAC secret for challenge binding). ' +
        'Generate with `openssl rand -hex 32` and put it in .env.',
    )
  }

  // SETTLEMENT_PRIVATE_KEY validation: required because the BSC Testnet USDT
  // deployment advertises permit2, which broadcasts a settlement tx
  // server-side. Without a signer, preflightCharge would throw with
  // "permit2 requires settlementAccount" anyway — catch it here with a
  // friendlier message that names the env var.
  if (!SETTLEMENT_PK_RAW) {
    throw new Error(
      'SETTLEMENT_PRIVATE_KEY env var must be set (server-side settlement signer for ' +
        'permit2 credentials). Generate with `openssl rand -hex 32` ' +
        'and prefix with 0x, then put it in .env. The account MUST hold tBNB ' +
        'for gas — fund via https://testnet.bnbchain.org/faucet-smart.',
    )
  }
  // Accept both 0x-prefixed (66 chars) and bare hex (64 chars — what
  // `openssl rand -hex 32` outputs by default). Normalize to 0x-prefixed
  // because viem's `privateKeyToAccount` requires the `0x${string}` shape.
  const SETTLEMENT_PK_NORMALIZED = SETTLEMENT_PK_RAW.startsWith('0x')
    ? SETTLEMENT_PK_RAW
    : `0x${SETTLEMENT_PK_RAW}`
  if (!/^0x[a-fA-F0-9]{64}$/.test(SETTLEMENT_PK_NORMALIZED)) {
    throw new Error(
      'SETTLEMENT_PRIVATE_KEY must be 64 hex characters (a 32-byte private key), ' +
        'optionally prefixed with "0x". ' +
        `Got ${SETTLEMENT_PK_RAW.length} chars after the optional 0x prefix was ` +
        `accounted for. Check for stray quotes / spaces / line breaks in the .env value.`,
    )
  }
  const settlementAccount = privateKeyToAccount(SETTLEMENT_PK_NORMALIZED as `0x${string}`)

  return {
    recipient: RECIPIENT,
    secret: SECRET,
    settlementAccount,
    rpcUrl: process.env.RPC_URL,
    port: PORT,
  }
}
