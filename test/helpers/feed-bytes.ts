export interface SplitStrategy {
  readonly name: string
  split(bytes: Buffer): Buffer[]
}

export const whole: SplitStrategy = {
  name: 'whole',
  split: (bytes) => (bytes.length === 0 ? [] : [bytes]),
}

export const oneByteAtATime: SplitStrategy = {
  name: 'one-byte-at-a-time',
  split: (bytes) => Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)),
}

function mulberry32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomSplits(seed: number): SplitStrategy {
  return {
    name: `random-splits(seed=${seed})`,
    split(bytes) {
      const random = mulberry32(seed)
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < bytes.length) {
        const size = 1 + Math.floor(random() * 8)
        chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)))
        offset += size
      }
      return chunks
    },
  }
}

export function everyTwoWaySplit(bytes: Buffer): Buffer[][] {
  const cases: Buffer[][] = []
  for (let cut = 0; cut <= bytes.length; cut++) {
    cases.push([bytes.subarray(0, cut), bytes.subarray(cut)].filter((b) => b.length > 0))
  }
  return cases
}

export const splitStrategies: readonly SplitStrategy[] = [
  whole,
  oneByteAtATime,
  randomSplits(1),
  randomSplits(2),
  randomSplits(3),
]

export function forEachSplit(
  bytes: Buffer,
  body: (chunks: Buffer[], strategyName: string) => void,
): void {
  for (const strategy of splitStrategies) {
    body(strategy.split(bytes), strategy.name)
  }
}

export function crlf(...lines: string[]): Buffer {
  return Buffer.from(lines.map((line) => line + '\r\n').join(''), 'latin1')
}

export function join(chunks: readonly Buffer[]): Buffer {
  return Buffer.concat(chunks as Buffer[])
}
