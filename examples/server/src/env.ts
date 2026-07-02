import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env')

if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}
