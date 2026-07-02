import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'

import { App } from '@/App'
import { wagmiConfig } from '@/lib/wagmi'

import './index.css'

const queryClient = new QueryClient()

const rainbowTheme = darkTheme({
  accentColor: '#f0b90b',
  accentColorForeground: '#1a1a1a',
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
})

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root element missing from index.html')
}

createRoot(container).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={rainbowTheme} modalSize="compact">
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
