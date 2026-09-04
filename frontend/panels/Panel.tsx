// module 8.4  frontend/panels/Panel.tsx -- the chrome the three panels share

import type { ReactElement, ReactNode } from 'react'

export interface PanelProps {
  readonly title: string
  /** One line under the title, where the panel needs to say what it is showing. */
  readonly hint?: ReactNode
  /** Rendered top right, for a panel that has a control. */
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function Panel({ title, hint, action, children }: PanelProps): ReactElement {
  return (
    <section className="rounded-sm border border-line bg-panel p-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xs font-normal tracking-[0.12em] uppercase text-dim">{title}</h2>
          {hint === undefined ? null : <p className="mt-1 text-xs text-dim">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
