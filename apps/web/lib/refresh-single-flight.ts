// Single-flight with a short memory, used by app/api/auth/refresh/route.ts.
//
// Concurrent callers presenting the same key share ONE in-flight call. The
// plain version of that (a Map entry deleted the moment the call settles) has
// a gap: a second tab whose request was sent with the old refresh cookie but
// reaches the server just AFTER the first call settled starts a second
// rotation of an already-rotated token. The backend then sees a replay
// (refresh-token reuse, backlog #43). So a settled value the caller marks as
// worth keeping is retained for `retainMs` and handed to late callers with the
// same key. Failures and transient errors are never retained: the next caller
// retries for real.
//
// In-process only. A multi-instance deploy (e.g. serverless) shares nothing
// between instances, which is what the backend's reuse grace window
// (REFRESH_REUSE_GRACE_SECONDS) covers.

export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Drop every entry and its timer (tests; never needed in production). */
  clear(): void;
}

export interface SingleFlightOptions<T> {
  /** How long to keep a settled value, read when the call settles. 0 = don't. */
  retainMs: () => number;
  /** Whether a settled value may be replayed to late callers. */
  shouldRetain: (value: T) => boolean;
}

interface Entry<T> {
  promise: Promise<T>;
  timer?: ReturnType<typeof setTimeout>;
}

const registry = new Set<{ clear(): void }>();

export function createSingleFlight<T>(options: SingleFlightOptions<T>): SingleFlight<T> {
  const entries = new Map<string, Entry<T>>();

  const flight: SingleFlight<T> = {
    run(key, fn) {
      const existing = entries.get(key);
      if (existing) return existing.promise;

      const entry: Entry<T> = { promise: fn() };
      entries.set(key, entry);
      const drop = () => {
        if (entries.get(key) === entry) entries.delete(key);
      };
      // Registered before any caller awaits, so a value that is not retained
      // is gone before the first awaiting caller resumes.
      entry.promise.then((value) => {
        const ms = options.retainMs();
        if (ms > 0 && options.shouldRetain(value)) {
          entry.timer = setTimeout(drop, ms);
          // Never keep the process alive for a cache entry.
          (entry.timer as { unref?: () => void }).unref?.();
        } else {
          drop();
        }
      }, drop);
      return entry.promise;
    },
    clear() {
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      entries.clear();
    },
  };
  registry.add(flight);
  return flight;
}

/** Clear every flight created by createSingleFlight (test isolation). */
export function clearAllSingleFlights(): void {
  for (const flight of registry) flight.clear();
}
