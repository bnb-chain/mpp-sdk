import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { expect, test } from 'vitest'

import { B402Client } from './Client.js'

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

test('native 307 redirects cannot forward Tesla merchant credentials or signed bodies', async () => {
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
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const client = new B402Client({
      baseUrl: entryUrl,
      clientId: 'merchant',
      accessToken: 'secret',
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    })
    await expect(client.supported()).rejects.toThrow()
    expect(forwarded).toBe(0)
  } finally {
    await Promise.all([close(entry), close(destination)])
  }
})
