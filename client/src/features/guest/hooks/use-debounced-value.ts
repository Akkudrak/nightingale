import { useEffect, useState } from 'react';

/**
 * Returns a value that lags behind the input by `delayMs` once the input
 * stops changing. The first emitted value matches the initial input so the
 * hook stays a drop-in replacement for the immediate value in render paths.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (debounced === value) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [debounced, delayMs, value]);

  return debounced;
}
