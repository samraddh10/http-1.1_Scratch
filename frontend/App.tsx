// module 8.1/8.2  frontend/App.tsx -- the whole page; there is no router and no second screen

import type { ReactElement } from 'react'

import { StatRow } from './panels/StatRow'
import { useMetricsStream } from './useMetricsStream'

export function App(): ReactElement {
  const { snapshot, status } = useMetricsStream()

  return (
    <div className="page">
      <header className="masthead">
        <h1>wirehttp</h1>
        <p>an HTTP/1.1 server on raw TCP sockets, serving this page over its own wire format</p>
        <span className={`stream stream-${status}`}>{status}</span>
      </header>

      <main className="panels">
        <StatRow snapshot={snapshot} />
      </main>
    </div>
  )
}
