import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    open: true,
    // Proxy /api/* to the local charge-server (:3000) so the demo can
    // do real end-to-end flows (402 challenge fetch → Authorization
    // submit → Payment-Receipt) without hitting CORS. Override via the
    // `VITE_CHARGE_SERVER_URL` env var if your server runs elsewhere.
    proxy: {
      '/api': {
        target: process.env.VITE_CHARGE_SERVER_URL ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
