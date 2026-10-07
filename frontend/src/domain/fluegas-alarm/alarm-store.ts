/**
 * 烟气净化告警域的本地持久化：阈值参数与在线排放监测待核对台账各占一个
 * localStorage 键，与业务记录的存储（local-store）相互独立。
 */
import type { AlarmParams, CemsLedgerEntry } from './types'

const PARAMS_KEY = 'waste-to-energy-plant:fluegas-alarm-params'
const LEDGER_KEY = 'waste-to-energy-plant:fluegas-alarm-ledger'

/**
 * 默认阈值（全厂同一份参数）。改阈值走 updateAlarmParams 的版本化更新，
 * 页面上没有第二处写死的高低比较数。
 * 反应塔温度：半干法脱酸反应塔正常工作区间约 140~170 ℃；
 * 活性炭喷射量：按净化线常规给料区间 8~15 kg/h。
 */
export const DEFAULT_ALARM_PARAMS: AlarmParams = {
  version: 1,
  updatedAt: '',
  updatedBy: '系统初始化',
  limits: {
    反应塔温度: { min: 140, max: 170, unit: '℃' },
    活性炭喷射量: { min: 8, max: 15, unit: 'kg/h' },
  },
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(key, JSON.stringify(fallback))
    return clone(fallback)
  }
}

let paramsCache: AlarmParams | null = null
let ledgerCache: CemsLedgerEntry[] | null = null

export function loadParams(): AlarmParams {
  if (paramsCache === null) {
    paramsCache = readJSON(PARAMS_KEY, DEFAULT_ALARM_PARAMS)
  }
  return paramsCache
}

export function saveParams(params: AlarmParams): void {
  paramsCache = params
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PARAMS_KEY, JSON.stringify(params))
  }
}

export function loadLedger(): CemsLedgerEntry[] {
  if (ledgerCache === null) {
    ledgerCache = readJSON<CemsLedgerEntry[]>(LEDGER_KEY, [])
  }
  return ledgerCache
}

export function saveLedger(entries: CemsLedgerEntry[]): void {
  ledgerCache = entries
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(entries))
  }
}

/** 回到初始阈值并清空待核对台账（业务记录的重置仍走各模块自己的 resetModule）。 */
export function resetAlarmData(): void {
  saveParams(clone(DEFAULT_ALARM_PARAMS))
  saveLedger([])
}
