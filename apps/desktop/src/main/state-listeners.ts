/** A listener or diagnostic failure cannot change committed state or suppress later listeners. */
export function notifyStateListeners<Value>(
  listeners: Iterable<(value: Value) => void>,
  value: Value,
  reportError: (error: unknown) => void,
): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      try {
        reportError(error);
      } catch {
        // Reporting is diagnostic only.
      }
    }
  }
}
