import { createServer, type Server } from 'node:http'

import { expect, test } from 'vitest'

import { probeChallenge, submitPayment, PaymentSideEffectError } from './request.js'
import type { LogicalPath } from './routes.js'

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

test('native redirects cannot provide a different payment challenge or receive a paid retry', async () => {
  let forwarded = 0
  const destination = createServer((_req, res) => {
    forwarded += 1
    res.end('{}')
  })
  const destinationUrl = await listen(destination)
  const entry = createServer((_req, res) => {
    res.writeHead(307, { Location: destinationUrl })
    res.end()
  })
  const entryUrl = await listen(entry)
  try {
    await expect(probeChallenge(fetch, entryUrl)).rejects.toThrow()
    const route = { id: 'mpp:hash' } as LogicalPath
    await expect(
      submitPayment(fetch, entryUrl, undefined, 'Payment credential', route),
    ).rejects.toBeInstanceOf(PaymentSideEffectError)
    expect(forwarded).toBe(0)
  } finally {
    await Promise.all([close(entry), close(destination)])
  }
})
