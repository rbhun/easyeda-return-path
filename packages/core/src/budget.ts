// Cooperative execution for long analyses. Analysis steps are generators that yield progress ticks
// often; a driver runs them either synchronously (CLI, tests) or in time slices that hand control
// back to the host between slices (the extension), with a time budget, cancellation and progress.
// No timers or I/O here: the host passes its own yield function.

export interface Tick {
  phase: string;
  /** Progress within the phase, 0–1, when known. */
  fraction?: number;
  /** Item count of the phase (e.g. chains), when it walks a list. */
  steps?: number;
}

export type Steps<T> = Generator<Tick | undefined, T, void>;

export type AbortReason = 'cancelled' | 'time' | 'complexity';

export class AnalysisAborted extends Error {
  constructor(
    readonly reason: AbortReason,
    message: string,
    readonly phase?: string,
  ) {
    super(message);
    this.name = 'AnalysisAborted';
  }
}

export interface RunOptions {
  /** Abort with reason 'time' when the run takes longer than this, ms. */
  timeBudgetMs?: number;
  /** Longest stretch of work between two yields to the host, ms (async runs). */
  sliceMs?: number;
  /** Set `aborted` to stop at the next tick. */
  signal?: { aborted: boolean };
  onProgress?: (t: Tick) => void;
  /** Phase changes with the elapsed time of the previous phase, for diagnostics. */
  onPhase?: (phase: string, previous: string | undefined, previousMs: number) => void;
  /** Hands control back to the host (timer, message loop). Async runs only. */
  yieldFn?: () => Promise<void>;
  now?: () => number;
}

function driver(opts: RunOptions) {
  const now = opts.now ?? (() => Date.now());
  const start = now();
  let phase: string | undefined;
  let phaseStart = start;
  return {
    now,
    check(t: Tick | undefined) {
      // The time since the last tick went to the phase that was running, not the one this tick starts.
      if (opts.timeBudgetMs !== undefined && now() - start > opts.timeBudgetMs && phase !== undefined)
        throw new AnalysisAborted('time', `Analysis stopped after ${Math.round(opts.timeBudgetMs / 1000)} s (time budget) during "${phase}". The net or its reference copper is too large; try a smaller net or a coarser setting.`, phase);
      if (t && t.phase !== phase) {
        const tNow = now();
        opts.onPhase?.(t.phase, phase, tNow - phaseStart);
        phase = t.phase;
        phaseStart = tNow;
      }
      if (t) opts.onProgress?.(t);
      if (opts.signal?.aborted) throw new AnalysisAborted('cancelled', 'Analysis cancelled.', phase);
      if (opts.timeBudgetMs !== undefined && now() - start > opts.timeBudgetMs)
        throw new AnalysisAborted('time', `Analysis stopped after ${Math.round(opts.timeBudgetMs / 1000)} s (time budget) during "${phase ?? 'start'}". The net or its reference copper is too large; try a smaller net or a coarser setting.`, phase);
    },
    finish() {
      opts.onPhase?.('done', phase, now() - phaseStart);
    },
  };
}

/** Runs the steps to completion on the calling thread (still honours the time budget and the signal). */
export function runSync<T>(steps: Steps<T>, opts: RunOptions = {}): T {
  const d = driver(opts);
  for (;;) {
    const r = steps.next();
    if (r.done) {
      d.finish();
      return r.value;
    }
    d.check(r.value);
  }
}

/** Runs the steps in slices of at most `sliceMs`, yielding to the host between slices. */
export async function runAsync<T>(steps: Steps<T>, opts: RunOptions = {}): Promise<T> {
  const d = driver(opts);
  const slice = opts.sliceMs ?? 30;
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  let sliceStart = d.now();
  for (;;) {
    const r = steps.next();
    if (r.done) {
      d.finish();
      return r.value;
    }
    d.check(r.value);
    if (d.now() - sliceStart >= slice) {
      await yieldFn();
      sliceStart = d.now();
    }
  }
}

/** Yields a tick every `every` calls; use inside hot loops of a generator via `yield* ticker.tick()`. */
export function ticker(phase: string, every = 64) {
  let n = 0;
  return {
    *tick(fraction?: number): Generator<Tick, void, void> {
      if (++n % every === 0) yield { phase, fraction };
    },
  };
}
