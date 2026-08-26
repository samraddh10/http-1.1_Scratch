//Purpose: defines the five possible states a request parse can be in, each paired with a string value.
export const State = {
  RequestLine: 'request-line',
  Headers: 'headers',
  Body: 'body',
  Complete: 'complete',
  Error: 'error',
} as const

export type State = (typeof State)[keyof typeof State]

//Purpose: for each state, lists every other state the parser is allowed to move to directly from it. This is the actual rulebook the rest of the file checks against.
const transitions: Readonly<Record<State, readonly State[]>> = {
  [State.RequestLine]: [State.Headers, State.Error],
  [State.Headers]: [State.Body, State.Complete, State.Error],
  [State.Body]: [State.Complete, State.Error],
  [State.Complete]: [State.RequestLine],
  [State.Error]: [],
}

//Purpose: answers a yes/no question — is moving from state from to state to a legal move according to the table above?
export function canTransition(from: State, to: State): boolean {
  return transitions[from].includes(to)
}

//Purpose: the same check as canTransition, but instead of returning false for an illegal move, it throws an error immediately. This is what the parser actually calls each time it changes state,
export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new Error(`RequestParser: illegal transition ${from} -> ${to}`)
  }
}

/**
 * What one step reports back to the drive loop.
 *
 * `NeedMore` carries an obligation: a step that returns it must have consumed nothing, so
 * that the next chunk sees the same bytes plus more. Half-consuming and then asking for
 * more bytes is how a parser loses a field boundary.
 *
 * It lives here rather than beside the drive loop because the body decoders report with it
 * too, and importing it from the parser they are imported by would be a cycle.
 */
export const Step = {
  Advanced: 'advanced',
  NeedMore: 'need-more',
} as const

export type Step = (typeof Step)[keyof typeof Step]
