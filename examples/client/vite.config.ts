import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // loadEnv, NOT process.env: Vite injects .env files into import.meta.env for
  // APP code only — this config file runs in Node and would otherwise see just
  // the shell env, silently ignoring a .env-supplied VITE_CHARGE_SERVER_URL.
  const env = loadEnv(mode, __dirname, '')
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      open: true,
      // Proxy both payment wires to the local example server (:3001) so the
      // demo can do real end-to-end flows without hitting CORS:
      //   /api/*  — mppx charge wire (402 challenge → Authorization → receipt)
      //   /x402/* — standalone x402 wire (402 JSON → X-PAYMENT → settle)
      // Override via the `VITE_CHARGE_SERVER_URL` env var (shell or .env) if
      // your server runs elsewhere.
      proxy: {
        '/api': {
          target: env['VITE_CHARGE_SERVER_URL'] ?? 'http://localhost:3001',
          changeOrigin: true,
        },
        '/x402': {
          target: env['VITE_CHARGE_SERVER_URL'] ?? 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
