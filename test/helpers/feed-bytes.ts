// module 0.3  test/helpers/feed-bytes.ts -- drive a parser: whole / one-byte / random splits
//
// This file exists before the parser it is for, on purpose.
//
// TCP delivers a byte stream with no message boundaries. A single request can arrive in
// forty `data` events or one, and the split points are decided by the network, not the
// client. A parser that works when handed a whole request and breaks when handed it one
// byte at a time is the single most common way this project fails -- and it fails
// invisibly, because manual testing with curl on localhost almost always delivers the
// whole request in one chunk.
//
// So every parser test from subphase 2.2 onward runs its fixture through all of these
// strategies and asserts the results are identical. The property being tested is not
// "does it parse", it is "does the answer depend on how the bytes were chopped up".
//
// These helpers deliberately know nothing about the parser. They turn one buffer into a
// list of chunks; the caller feeds those chunks to whatever interface the parser ends up
// having. That keeps the harness usable before the parser exists and stable after it
// changes.

/** A named way of chopping one buffer into the chunks a parser will be fed. */
export interface SplitStrategy {
  readonly name: string
  split(bytes: Buffer): Buffer[]
}

/** Everything in one chunk: the easy case, and the one manual testing usually exercises. */
export const whole: SplitStrategy = {
  name: 'whole',
  split: (bytes) => (bytes.length === 0 ? [] : [bytes]),
}

/** One byte per chunk: the worst case, and the one that finds state-machine bugs. */
export const oneByteAtATime: SplitStrategy = {
  name: 'one-byte-at-a-time',
  split: (bytes) => Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)),
}

/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * Seeded rather than `Math.random()` so a failing split is reproducible. A flaky test that
 * cannot be re-run with the same input is worse than no test: it tells you something is
 * broken and then hides which case broke it.
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random chunk sizes from a fixed seed. Reproducible; the seed is in the strategy name. */
export function randomSplits(seed: number): SplitStrategy {
  return {
    name: `random-splits(seed=${seed})`,
    split(bytes) {
      const random = mulberry32(seed)
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < bytes.length) {
        // 1..8 bytes at a time: small enough to land inside a header name, a chunk-size
        // line, or a CRLF pair, which is exactly where the interesting bugs are.
        const size = 1 + Math.floor(random() * 8)
        chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)))
        offset += size
      }
      return chunks
    },
  }
}

/**
 * Every possible two-way split, including the empty-prefix and empty-suffix cases.
 *
 * Exhaustive rather than sampled. For a 60-byte request that is 61 cases and costs
 * nothing, and it guarantees a split lands between every adjacent pair of bytes -- notably
 * between the CR and the LF of every CRLF, which is the boundary most likely to be
 * mishandled.
 */
export function everyTwoWaySplit(bytes: Buffer): Buffer[][] {
  const cases: Buffer[][] = []
  for (let cut = 0; cut <= bytes.length; cut++) {
    cases.push([bytes.subarray(0, cut), bytes.subarray(cut)].filter((b) => b.length > 0))
  }
  return cases
}

/** The strategies every parser test should run. */
export const splitStrategies: readonly SplitStrategy[] = [
  whole,
  oneByteAtATime,
  randomSplits(1),
  randomSplits(2),
  randomSplits(3),
]

/**
 * Runs `body` once per split strategy.
 *
 * The strategy name is passed through so an assertion failure says which chopping caused
 * it -- `expected 200, got 400 (one-byte-at-a-time)` is a bug report; `expected 200, got
 * 400` is a puzzle.
 */
export function forEachSplit(
  bytes: Buffer,
  body: (chunks: Buffer[], strategyName: string) => void,
): void {
  for (const strategy of splitStrategies) {
    body(strategy.split(bytes), strategy.name)
  }
}

/** Builds a byte buffer from CRLF-terminated lines. */
export function crlf(...lines: string[]): Buffer {
  // Every line, including the last, is terminated. So the blank line that ends a header
  // section is written as a trailing '' -- explicit, because in HTTP that empty line is a
  // real delimiter and hiding it would hide the thing being tested.
  return Buffer.from(lines.map((line) => line + '\r\n').join(''), 'latin1')
}

/** Reassembles chunks, so a test can assert no bytes were lost or reordered by a strategy. */
export function join(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat(chunks as Buffer[])
}
