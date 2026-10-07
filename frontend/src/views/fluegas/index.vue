<template>
  <section class="page" data-module="fluegas">
    <header class="page-head">
      <div>
        <h2>烟气净化运行管理</h2>
        <p class="page-desc">反应塔温度、活性炭喷射量的告警高低统一由共用判定计算，净化列表、净化详情、值班待办三处同一份结果。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出烟气净化运行清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>告警判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['净化编号'] }}</td>
          <td>{{ row['反应塔温度'] === '' || row['反应塔温度'] === null ? '—' : row['反应塔温度'] }}</td>
          <td>{{ row['活性炭喷射量'] === '' || row['活性炭喷射量'] === null ? '—' : row['活性炭喷射量'] }}</td>
          <td>{{ row['石灰浆流量'] ?? '—' }}</td>
          <td>{{ row.outletTemp === null ? '—' : `${row.outletTemp} ℃` }}</td>
          <td>{{ row['操作人员'] ?? '—' }}</td>
          <td>{{ row['记录时间'] ?? '—' }}</td>
          <td>
            <span class="alarm-badge" :class="badgeClass(row.verdict?.level)">
              {{ verdictText(row.verdict?.level) }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">净化详情</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无烟气净化运行数据</td>
        </tr>
      </tbody>
    </table>

    <section v-if="dupAudit.length" class="dup-audit">
      <h3>重复登记审计</h3>
      <p class="page-desc">同一台净化线重复登记只保留先落库的一条正本，以下记录已去重，不参与告警判定与台账同步。</p>
      <table class="data-table">
        <thead>
          <tr><th>重复记录</th><th>净化编号</th><th>保留正本</th><th>丢弃时间</th><th>原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in dupAudit" :key="String(item.id)">
            <td>#{{ item.原始记录 }}</td>
            <td>{{ item.净化编号 }}</td>
            <td>#{{ item.保留正本 }}</td>
            <td>{{ item.丢弃时间 }}</td>
            <td>{{ item.原因 }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条烟气净化运行记录（正本）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal-card">
        <header class="modal-head">
          <h3>净化详情 · {{ detail['净化编号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <p class="page-desc">
          当前状态「{{ detail.status }}」· 参数版本 v{{ versionOf(detail) }}
          <template v-if="archivedOf(detail)">
            · 已于 {{ detail['告警留档时间'] }} 停运留档，按当时的{{ detail['告警留档'] }}存档，不做重判
          </template>
        </p>

        <table class="data-table detail-table">
          <thead>
            <tr><th>告警因子</th><th>实测值</th><th>工艺区间</th><th>判定高低</th></tr>
          </thead>
          <tbody>
            <tr v-for="metric in detail.verdict?.metrics ?? []" :key="metric.factor">
              <td>{{ metric.factor }}</td>
              <td>{{ metric.value === null ? '未采集' : `${metric.value} ${metric.unit}` }}</td>
              <td>{{ metric.range.min }}~{{ metric.range.max }} {{ metric.unit }}</td>
              <td><span class="alarm-badge" :class="badgeClass(metric.level)">{{ metric.level }}</span></td>
            </tr>
            <tr v-if="!(detail.verdict?.metrics ?? []).length">
              <td colspan="4" class="empty-state">该记录为停运留档，明细：{{ detail['告警留档明细'] }}</td>
            </tr>
          </tbody>
        </table>

        <p class="page-desc">
          出口烟气温度按反应塔温度统一折算（温降 {{ OUTLET_TEMP_DROP }}℃）：
          <strong>{{ detail.outletTemp === null ? '无法折算' : `${detail.outletTemp} ℃` }}</strong>
          ，折算值只作展示，告警仍只认反应塔温度这一份取数来源。
        </p>

        <form v-if="editable" class="filter-bar" @submit.prevent="saveParams">
          <label class="filter-item">
            <span>反应塔温度（℃，{{ TOWER_TEMP_RANGE.min }}~{{ TOWER_TEMP_RANGE.max }}）</span>
            <input v-model.number="form.towerTemp" type="number" />
          </label>
          <label class="filter-item">
            <span>活性炭喷射量（kg/h，{{ CARBON_RANGE.min }}~{{ CARBON_RANGE.max }}）</span>
            <input v-model.number="form.carbon" type="number" step="0.1" />
          </label>
          <button class="btn primary" type="submit">保存参数</button>
          <span v-if="formError" class="error-text">{{ formError }}</span>
          <span v-if="formOk" class="ok-text">{{ formOk }}</span>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import { fluegasAlarmApi, type FluegasViewRow } from '@/api/fluegas-alarm-service'
import {
  ARCHIVED_AT_FIELD,
  ARCHIVED_VERSION_FIELD,
  CARBON_RANGE,
  OUTLET_TEMP_DROP,
  TOWER_TEMP_RANGE,
  type MetricLevel,
} from '@/domain/fluegas-alarm'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fluegas')
const columns = ["净化编号", "反应塔温度", "活性炭喷射量", "石灰浆流量", "出口烟气温度(折算)", "操作人员", "记录时间"]
const actions = ["提交投运", "登记停运", "上报异常"]
const statuses = ["待投运", "运行中", "已停运", "指标异常"]

const rows = ref<FluegasViewRow[]>([])
const total = ref(0)
const stats = ref<{ label: string; value: number }[]>([])
const dupAudit = ref<EntryRow[]>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["净化编号", "反应塔温度", "活性炭喷射量"]

const detail = ref<FluegasViewRow | null>(null)
const form = ref({ towerTemp: 0, carbon: 0 })
const formError = ref('')
const formOk = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const editable = computed(() => {
  if (!detail.value) {
    return false
  }
  return ['运行中', '指标异常'].includes(String(detail.value.status))
})

function versionOf(row: FluegasViewRow): number {
  return Number(row[ARCHIVED_VERSION_FIELD] ?? 0)
}

function archivedOf(row: FluegasViewRow): boolean {
  return String(row[ARCHIVED_AT_FIELD] ?? '') !== ''
}

function verdictText(level: MetricLevel | null | undefined): string {
  if (level === null || level === undefined) {
    return '未投运'
  }
  return level
}

function badgeClass(level: MetricLevel | null | undefined): string {
  if (level === '偏高') return 'badge-high'
  if (level === '偏低') return 'badge-low'
  if (level === '数据缺失') return 'badge-missing'
  if (level === '正常') return 'badge-ok'
  return 'badge-idle'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 导出走正本清单，重复登记的记录不重复出现在文件里。
  downloadEntries(meta.key)
}

function openDetail(row: FluegasViewRow) {
  formError.value = ''
  formOk.value = ''
  detail.value = row
  form.value = {
    towerTemp: typeof row['反应塔温度'] === 'number' ? Number(row['反应塔温度']) : 0,
    carbon: typeof row['活性炭喷射量'] === 'number' ? Number(row['活性炭喷射量']) : 0,
  }
}

function closeDetail() {
  detail.value = null
}

function saveParams() {
  if (!detail.value) {
    return
  }
  formError.value = ''
  formOk.value = ''
  const result = fluegasAlarmApi.updateParams(Number(detail.value.id), {
    towerTemp: form.value.towerTemp,
    carbon: form.value.carbon,
    expectedVersion: versionOf(detail.value),
  })
  if (!result.ok) {
    formError.value = result.message
    reload()
    const latest = fluegasAlarmApi.getFluegasDetail(Number(detail.value.id))
    if (latest) {
      detail.value = latest
      form.value = {
        towerTemp: typeof latest['反应塔温度'] === 'number' ? Number(latest['反应塔温度']) : 0,
        carbon: typeof latest['活性炭喷射量'] === 'number' ? Number(latest['活性炭喷射量']) : 0,
      }
    }
    return
  }
  formOk.value = `参数已保存，版本更新为 v${result.version}。三个入口的告警高低已按新值统一刷新，并同步到在线排放监测待核对台账。`
  reload()
  const latest = fluegasAlarmApi.getFluegasDetail(Number(detail.value.id))
  if (latest) {
    detail.value = latest
  }
}

function runAction(action: string, row: FluegasViewRow) {
  errorMessage.value = ''
  formError.value = ''
  const result = fluegasAlarmApi.runFluegasAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    if (detail.value && Number(detail.value.id) === Number(row.id)) {
      formError.value = result.message
    }
    return
  }
  errorMessage.value = result.message
  reload()
  if (detail.value && Number(detail.value.id) === Number(row.id)) {
    const latest = fluegasAlarmApi.getFluegasDetail(Number(row.id))
    if (latest) {
      detail.value = latest
    }
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = fluegasAlarmApi.listFluegas(filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = fluegasAlarmApi.fluegasStats()
    dupAudit.value = fluegasAlarmApi.listDupAudit()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '烟气净化运行列表读取失败'
  }
}

onMounted(reload)
</script>
