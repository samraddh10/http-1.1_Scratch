// module 8.4  frontend/panels/Panel.tsx -- the chrome the panels share

import type { ReactElement, ReactNode } from 'react'

export interface PanelProps {
  readonly title: string
  /** One line under the title, where the panel needs to say what it is showing. */
  readonly hint?: ReactNode
  /** Rendered top right, for a panel that has a control or a count. */
  readonly action?: ReactNode
  readonly children: ReactNode
}

export function Panel({ title, hint, action, children }: PanelProps): ReactElement {
  return (
    <section className="flex min-w-0 flex-col rounded-md border border-line bg-panel">
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xs font-medium tracking-[0.14em] uppercase">
            <span aria-hidden="true" className="h-3 w-px bg-accent" />
            {title}
          </h2>
          {hint === undefined ? null : (
            <p className="mt-1.5 max-w-prose font-sans text-xs leading-relaxed text-dim">{hint}</p>
          )}
        </div>
        {action}
      </div>
      <div className="min-w-0 grow p-4">{children}</div>
    </section>
  )
}
