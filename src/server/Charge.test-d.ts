/**
 * Type-level tests for `charge()` / `chargeAsync()` factory return type
 * (spec §10).
 *
 * The `Method.Server<typeof chargeMethod, ChargeServerDefaults,
 * Transport.Http>` annotation must let `Mppx.create({ methods: [...] })
 * .evm.charge({ amount })` typecheck with ONLY `amount` — every other
 * wire field is supplied by the factory defaults. An older signature
 * that erased the defaults generic to `{}` forced callers to pass
 * `currency` / `recipient` / `methodDetails`.
 *
 * Picked up by vp test under the typecheck.include glob targeting any
 * `.test-d.ts` file under `src/`. Compile-time only — no runtime
 * assertions.
 */

import { Mppx } from 'mppx/server'
import { expectTypeOf, test } from 'vitest'

import { type ChargeServerDefaults, type ServerParameters, charge, chargeAsync } from './Charge.js'

declare const stubParams: ServerParameters
declare const stubPrepared: Parameters<typeof charge>[0]

test('chargeAsync return type — handler.evm.charge accepts { amount } alone', async () => {
  const server = await chargeAsync(stubParams)
  const handler = Mppx.create({ methods: [server], secretKey: 'x' })

  // Single-field call must typecheck. Catches the regression where
  // explicit Method.Server<..., {}, ...> erased the defaults generic
  // and forced every wire field at the call site.
  handler.evm.charge({ amount: '1000000' })

  // externalId is also optional — varies per route per spec §10.
  handler.evm.charge({ amount: '1000000', externalId: 'order-42' })

  // description likewise.
  handler.evm.charge({ amount: '1000000', description: 'Premium article' })
})

test('charge() return type — defaults generic preserved', () => {
  const server = charge(stubPrepared)
  const handler = Mppx.create({ methods: [server], secretKey: 'x' })
  handler.evm.charge({ amount: '1000000' })
})

test('amount is REQUIRED at the route call site', async () => {
  // Wire schema (src/Methods.ts) marks `amount` REQUIRED. The factory
  // defaults INTENTIONALLY do not include amount in the type — so a
  // route call without amount must FAIL to typecheck. Putting amount
  // in defaults would let `handler.evm.charge({})` slip through TS
  // and only blow up at runtime schema.parse.
  const server = await chargeAsync(stubParams)
  const handler = Mppx.create({ methods: [server], secretKey: 'x' })

  // @ts-expect-error — amount is required, omitting it MUST be a type error
  handler.evm.charge({})

  // @ts-expect-error — externalId alone is not enough; amount required
  handler.evm.charge({ externalId: 'order-42' })

  // Sanity: with amount present, call typechecks
  handler.evm.charge({ amount: '1000000' })
})

test('ChargeServerDefaults exposes the wire fields the factory bakes in', () => {
  // Stability check — ChargeServerDefaults is part of the public surface
  // now (server barrel exports it), so changing its shape is a SemVer
  // event. Keep this assertion in sync with the type declaration.
  //
  // amount is DELIBERATELY ABSENT from this shape. Adding it
  // back would let `handler.evm.charge({})` typecheck and runtime-fail.
  expectTypeOf<ChargeServerDefaults>().toEqualTypeOf<{
    description?: string
    externalId?: string
    currency: `0x${string}`
    recipient: `0x${string}`
    methodDetails: {
      chainId: number
      permit2Address: `0x${string}`
      // permit2Spender: present iff deployment configured settlementAccount —
      // required wire field for permit2/authorization so the user signs typed
      // data with the correct EIP-712 spender (Permit2 uses msg.sender).
      permit2Spender?: `0x${string}`
      credentialTypes: Array<'permit2' | 'authorization' | 'transaction' | 'hash'>
      decimals: number
      splits?: Array<{ recipient: `0x${string}`; amount: string; memo?: string }>
    }
  }>()
})
