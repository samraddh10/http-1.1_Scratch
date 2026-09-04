// module 8.1  frontend/App.tsx -- the whole page; there is no router and no second screen

import type { ReactElement } from 'react'

export function App(): ReactElement {
  return (
    <div className="page">
      <header className="masthead">
        <h1>wirehttp</h1>
        <p>an HTTP/1.1 server on raw TCP sockets, serving this page over its own wire format</p>
      </header>
      <main className="panels" />
    </div>
  )
}
