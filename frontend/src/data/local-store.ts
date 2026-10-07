import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'waste-to-energy-plant:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 业务集合（告警待核对台账、重复登记审计等）与模块清单分开存，互不干扰。
const COLLECTION_PREFIX = `${STORAGE_KEY}:`

function cloneCollection<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function loadCollection<T>(name: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return cloneCollection(fallback)
  }
  const raw = window.localStorage.getItem(COLLECTION_PREFIX + name)
  if (!raw) {
    window.localStorage.setItem(COLLECTION_PREFIX + name, JSON.stringify(fallback))
    return cloneCollection(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(COLLECTION_PREFIX + name, JSON.stringify(fallback))
    return cloneCollection(fallback)
  }
}

export function saveCollection<T>(name: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(COLLECTION_PREFIX + name, JSON.stringify(value))
  }
}
