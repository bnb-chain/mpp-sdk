import path from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
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
      // Same-origin proxy for the two /api/b402/* MPP routes.
      proxy: {
        '/api': {
          target: env['VITE_B402_SERVER_URL'] ?? 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  }
})
