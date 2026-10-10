import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import Shell from '@/components/Shell'
import './globals.css'

export const metadata: Metadata = {
  title: 'Hivemind',
  description: 'Console for the Hivemind decide → work → review loop',
}

export const viewport: Viewport = { colorScheme: 'light dark' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><Shell>{children}</Shell></body>
    </html>
  )
}
