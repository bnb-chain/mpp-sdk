/**
 * Step 3: local verify.
 *
 * Re-checks the just-built credential entirely client-side: challenge
 * HMAC / stored-lookup equality, then per-credential-type assertions
 * (hash matches the broadcast txHash + full Transfer-event decode;
 * parsed EIP-1559 tx fields; EIP-712 recover for permit2 / authorization).
 *
 * DEV-ONLY — this is NOT how a consumer uses the SDK. A real client just
 * builds a credential (`@bnb-chain/mpp/client`) and submits it; the server
 * is the verifier. This step re-derives the verification client-side purely
 * as a demo affordance ("see your signature recover to your own address"),
 * so it deliberately deep-imports the SDK's internal EIP-712 helpers from
 * `src/protocol/TypedData.js` — fine because the demo lives in this repo,
 * but not a pattern consumers should copy. Those helpers are intentionally
 * not part of the public `@bnb-chain/mpp` surface.
 */

import { Challenge, Credential, PaymentRequest } from 'mppx'
import {
  type Address,
  type Hex,
  type PublicClient,
  parseTransaction,
  recoverTypedDataAddress,
} from 'viem'

import { VerifyList } from '@/components/VerifyList'
import { PERMIT2_ADDRESS, getPresetByKey } from '@/protocol/presets.js'
import { type DemoState, type VerifyLine } from '@/state/types'

import {
  type ActionResult,
  DEMO_SECRET,
  TRANSFER_EVENT_ABI,
  getSignerAddress,
  panel,
  parseBaseUnitsOrThrow,
  shortAddr,
} from './shared'

export async function localVerify(
  state: DemoState,
  ctx: { publicClient: PublicClient | null; walletAddress: Address | null },
): Promise<ActionResult> {
  const credential = state.credential
  const challenge = state.challenge
  if (!credential || !challenge) throw new Error('Build a credential first.')
  const parsed = Credential.deserialize(credential)
  const preset = getPresetByKey(state.chainKey)
  const lines: VerifyLine[] = []
  let nextRecovered: Address | null = state.recovered

  // Defense-in-depth: dispatch by the deserialized payload's own type,
  // NOT by the UI tab. If they disagree, something is wrong (typically
  // a stale credential from another tab that wasn't cleared). With
  // per-type pools this shouldn't happen, but the guard catches any
  // future regression that lets credentials bleed across tabs.
  const payloadType = (parsed.payload as { type?: string }).type
  if (payloadType !== state.credentialType) {
    throw new Error(
      `Credential payload.type is "${payloadType ?? '<missing>'}" but the current ` +
        `tab is "${state.credentialType}". This usually means a stale credential ` +
        `from a different tab is still in state — click Clear and re-run.`,
    )
  }

  // Challenge HMAC / stored-lookup serialize equality.
  if (state.serverMode) {
    lines.push({
      label: 'Challenge HMAC verify',
      ok: 'skipped',
      detail: "skipped (server-issued challenge — server's secret is not exposed to the client)",
    })
  } else if (state.bindingMode === 'mppx-hmac' || state.bindingMode === 'mppx-managed') {
    const ok = Challenge.verify(parsed.challenge, { secretKey: DEMO_SECRET })
    lines.push({ label: 'Challenge HMAC verify', ok })
  } else {
    const a = PaymentRequest.serialize(parsed.challenge.request)
    const b = PaymentRequest.serialize(challenge.request)
    lines.push({ label: 'Stored-lookup request bytes equal', ok: a === b })
  }

  switch (state.credentialType) {
    case 'hash': {
      const payload = parsed.payload as { type: 'hash'; hash: Hex }
      const ok = state.settlementTxHash === payload.hash
      lines.push({ label: 'payload.hash matches the broadcast settlement txHash', ok })

      // Full Transfer-event decode + per-field compare.
      if (ctx.publicClient && state.settlementTxHash) {
        try {
          const receipt = await ctx.publicClient.getTransactionReceipt({
            hash: state.settlementTxHash,
          })
          const { parseEventLogs } = await import('viem')
          const transferLogs = parseEventLogs({
            abi: TRANSFER_EVENT_ABI,
            eventName: 'Transfer',
            logs: receipt.logs,
          })
          const expectedAmount = parseBaseUnitsOrThrow(state)
          const expectedRecipient = state.recipient.toLowerCase()
          const expectedToken = preset.currency.toLowerCase()
          const match = transferLogs.find(
            (log) =>
              log.address.toLowerCase() === expectedToken &&
              log.args.to.toLowerCase() === expectedRecipient &&
              log.args.value === expectedAmount,
          )
          if (match) {
            lines.push({ label: 'Decoded Transfer(token, to, value) matches challenge', ok: true })
            lines.push({
              label: '',
              ok: true,
              detail: `→ token=${match.address} from=${match.args.from} to=${match.args.to} value=${match.args.value}`,
            })
          } else {
            lines.push({
              label: 'Decoded Transfer match',
              ok: false,
              detail: `no log matches expected (token=${preset.currency}, to=${state.recipient}, value=${expectedAmount})`,
            })
          }
          lines.push({
            label: 'On-chain receipt status',
            ok: receipt.status === 'success',
            detail: `${receipt.status} (${transferLogs.length} Transfer log${
              transferLogs.length === 1 ? '' : 's'
            } in receipt)`,
          })
        } catch (e) {
          lines.push({
            label: 'Receipt fetch failed',
            ok: false,
            detail: (e as Error).message,
          })
        }
      }
      break
    }
    case 'transaction': {
      const payload = parsed.payload as { type: 'transaction'; signature: Hex }
      const tx = parseTransaction(payload.signature)
      const data = tx.data ?? '0x'
      const selectorOk = data.toLowerCase().startsWith('0xa9059cbb')
      lines.push({ label: 'Parsed tx type', ok: true, detail: String(tx.type) })
      lines.push({ label: 'Parsed chainId', ok: true, detail: String(tx.chainId ?? 'undefined') })
      lines.push({ label: 'Parsed to', ok: true, detail: tx.to ?? 'undefined' })
      lines.push({
        label: 'Calldata selector matches transfer(address,uint256)',
        ok: selectorOk,
      })
      break
    }
    case 'permit2': {
      const payload = parsed.payload as {
        type: 'permit2'
        permit: { nonce: string; deadline: string; permitted: Array<{ amount: string }> }
        signature: Hex
        witness: { challengeHash: Hex }
      }
      const isBatch = payload.permit.permitted.length > 1
      // Read the EIP-712 `spender` from the same field the credential
      // builder signed against — permit2Spender (the on-chain
      // msg.sender at Permit2 call time). Falling back to permit2Address
      // would reproduce the pre-fix bug where local recovery succeeded
      // but on-chain Permit2 reverted with InvalidSigner.
      const md = (
        challenge.request as {
          methodDetails?: { permit2Spender?: Address; permit2Address?: Address }
        }
      ).methodDetails
      if (!md?.permit2Spender) {
        throw new Error(
          'Permit2 local verify: challenge missing methodDetails.permit2Spender — ' +
            'this challenge was issued by a server pre-dating the Permit2 spender fix.',
        )
      }
      const permit2Spender: Address = md.permit2Spender
      // Recover against the SAME Permit2 contract the credential builder
      // signed against: the wire methodDetails.permit2Address (canonical
      // constant only as a fallback). If this drifts from buildCredential's
      // domain, recovery yields a different address and the match fails.
      const permit2Address: Address = md.permit2Address ?? PERMIT2_ADDRESS
      const { permit2BatchTypes, permit2Domain, permit2SingleTypes } =
        await import('../../../../src/protocol/TypedData.js')
      const recovered = isBatch
        ? await recoverTypedDataAddress({
            domain: permit2Domain(preset.chainId, permit2Address),
            types: permit2BatchTypes,
            primaryType: 'PermitBatchWitnessTransferFrom',
            message: {
              permitted: payload.permit.permitted.map((p) => ({
                token: preset.currency,
                amount: BigInt(p.amount),
              })),
              spender: permit2Spender,
              nonce: BigInt(payload.permit.nonce),
              deadline: BigInt(payload.permit.deadline),
              witness: { challengeHash: payload.witness.challengeHash },
            },
            signature: payload.signature,
          })
        : await recoverTypedDataAddress({
            domain: permit2Domain(preset.chainId, permit2Address),
            types: permit2SingleTypes,
            primaryType: 'PermitWitnessTransferFrom',
            message: {
              permitted: {
                token: preset.currency,
                amount: BigInt(payload.permit.permitted[0]!.amount),
              },
              spender: permit2Spender,
              nonce: BigInt(payload.permit.nonce),
              deadline: BigInt(payload.permit.deadline),
              witness: { challengeHash: payload.witness.challengeHash },
            },
            signature: payload.signature,
          })
      nextRecovered = recovered
      const expected = getSignerAddress(state, { address: ctx.walletAddress })
      const matches = recovered.toLowerCase() === expected.toLowerCase()
      lines.push({
        label: `EIP-712 recover (${isBatch ? 'batch' : 'single'})`,
        ok: true,
        detail: recovered,
      })
      lines.push({
        label: `Recovered === connected wallet (${shortAddr(expected)})`,
        ok: matches,
      })
      if (isBatch) {
        lines.push({
          label: 'Batch entries',
          ok: true,
          detail: `${payload.permit.permitted.length} (1 primary + ${payload.permit.permitted.length - 1} splits)`,
        })
      }
      break
    }
    case 'authorization': {
      const payload = parsed.payload as {
        type: 'authorization'
        from: Address
        to: Address
        value: string
        validAfter: string
        validBefore: string
        nonce: Hex
        signature: Hex
      }
      const { eip3009Domain, eip3009Types } = await import('../../../../src/protocol/TypedData.js')
      const recovered = await recoverTypedDataAddress({
        domain: eip3009Domain({
          tokenName: preset.eip712!.name,
          tokenVersion: preset.eip712!.version,
          chainId: preset.chainId,
          tokenAddress: preset.currency,
        }),
        types: eip3009Types,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: payload.from,
          to: payload.to,
          value: BigInt(payload.value),
          validAfter: BigInt(payload.validAfter),
          validBefore: BigInt(payload.validBefore),
          nonce: payload.nonce,
        },
        signature: payload.signature,
      })
      nextRecovered = recovered
      const matches = recovered.toLowerCase() === payload.from.toLowerCase()
      lines.push({ label: 'EIP-712 recover', ok: true, detail: recovered })
      lines.push({ label: 'Recovered === payload.from', ok: matches })
      lines.push({
        label: 'Validity window',
        ok: true,
        detail: `[${new Date(Number(payload.validAfter) * 1000).toISOString()}, ${new Date(
          Number(payload.validBefore) * 1000,
        ).toISOString()}]`,
      })
      break
    }
  }

  return {
    patch: { recovered: nextRecovered },
    panel: panel('Local verify', <VerifyList lines={lines} />),
  }
}
