import { useEffect, useState } from 'react'

/**
 * useState backed by localStorage — strings only (matches the existing
 * `loadPersisted` / `savePersisted` contract in `presets.ts`).
 *
 * Two-way binding: changes to the returned state propagate to localStorage,
 * and the initial render reads from localStorage if available.
 *
 * The generic T defaults to `string`; pass an explicit T (e.g. a union of
 * literals) to constrain values from the call site.
 */
export function usePersistedString<T extends string = string>(
  key: string,
  initial: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key)
      return (v ?? initial) as T
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // ignore — incognito mode or tight quota
    }
  }, [key, value])

  return [value, setValue]
}

export function usePersistedBoolean(
  key: string,
  initial: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key)
      if (v === null) return initial
      return v === 'true'
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      // ignore
    }
  }, [key, value])

  return [value, setValue]
}
