/**
 * Lets every pending promise continuation run: resolves after the current
 * microtask queue has drained (on the next macrotask turn). Not a sleep: no
 * wall-clock time is waited for.
 */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
