import { ConnectButton } from '@rainbow-me/rainbowkit'
import * as React from 'react'

export function Header(): JSX.Element {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
        <a href="/" className="group flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-bnb transition group-hover:bg-bnb2">
            <img src="/bnbchain.svg" alt="BNB Chain" className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-base font-extrabold tracking-tight">
              <span className="text-bnb">@bnb-chain/mpp</span>
              <span className="font-medium text-muted-foreground"> · Interactive Demo</span>
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              draft-evm-charge-00 on mppx@0.8.12
            </div>
          </div>
        </a>
        <div className="flex-1" />
        <ConnectButton
          accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
          chainStatus="icon"
        />
      </div>
    </header>
  )
}
