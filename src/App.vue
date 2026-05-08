<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const loading = ref(true)
const error = ref('')
const report = ref(null)
const index = ref({ scans: [] })
const selectedKey = ref('latest')
const lastFinished = ref(null)
const resetBusy = ref(false)
const resetMessage = ref('')
const startBusy = ref(false)
const startMessage = ref('')
const scanWaiting = ref(false)
const liveLogText = ref('')
const liveLogPre = ref(null)
let pollTimer = null
let logPollTimer = null

const reportUrl = computed(() => {
  if (selectedKey.value === 'latest') return '/generated/latest.json'
  const file = selectedKey.value
  if (!file) return '/generated/latest.json'
  return `/generated/${file}`
})

/** Solo encajes con ≥1 rol sugerido (nada de “ninguno cumplió…”). Ignora slots null (scan parcial). */
const companiesInReport = computed(() => {
  const list = report.value?.companies
  if (!Array.isArray(list)) return []
  return list.filter((c) => c && Array.isArray(c.relevantRoles) && c.relevantRoles.length > 0)
})

async function loadIndex() {
  try {
    const idxRes = await fetch('/generated/index.json', { cache: 'no-store' })
    if (idxRes.ok) index.value = await idxRes.json()
    else index.value = { scans: [] }
  } catch {
    index.value = { scans: [] }
  }
}

async function loadLastFinished() {
  try {
    const res = await fetch('/generated/last-finished.json', { cache: 'no-store' })
    if (!res.ok) {
      lastFinished.value = null
      return
    }
    lastFinished.value = await res.json()
  } catch {
    lastFinished.value = null
  }
}

async function loadReport() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(reportUrl.value, { cache: 'no-store' })
    if (!res.ok) {
      error.value =
        res.status === 404
          ? 'No hay reportes todavía. Usá el botón Start again arriba (solo con npm run dev) o npm run scan en la terminal. Entrada: config/generated/*-from-pdf.json.'
          : `No se pudo cargar (${res.status})`
      report.value = null
      return
    }
    report.value = await res.json()
  } catch (e) {
    error.value = String(e.message || e)
    report.value = null
  } finally {
    loading.value = false
  }
}

/** Durante el scan: snapshot parcial (no usar latest.json, puede ser de una corrida vieja). */
async function loadLiveProgressIfPartial() {
  try {
    const res = await fetch('/generated/live-progress.json', { cache: 'no-store' })
    if (!res.ok) return false
    const j = await res.json()
    if (j.partial !== true) return false
    report.value = j
    error.value = ''
    loading.value = false
    return true
  } catch {
    return false
  }
}

async function refreshLiveLog() {
  try {
    const r = await fetch('/generated/live-scan.log', { cache: 'no-store' })
    if (!r.ok) {
      if (!scanWaiting.value) liveLogText.value = ''
      return
    }
    liveLogText.value = await r.text()
  } catch {
    /* noop */
  }
}

onMounted(async () => {
  await Promise.all([loadIndex(), loadLastFinished()])
  await loadReport()
  void refreshLiveLog()
})

function stopScanPoll() {
  if (pollTimer != null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (logPollTimer != null) {
    clearInterval(logPollTimer)
    logPollTimer = null
  }
  scanWaiting.value = false
  void refreshLiveLog()
}

watch(liveLogText, async () => {
  await nextTick()
  const el = liveLogPre.value
  if (el) el.scrollTop = el.scrollHeight
})

onUnmounted(() => {
  stopScanPoll()
})

const POLL_MS = 5000
const POLL_MAX = 720

async function refreshResults() {
  await Promise.all([loadIndex(), loadLastFinished()])
  const partial = await loadLiveProgressIfPartial()
  if (!partial && !scanWaiting.value) {
    await loadReport()
  }
}

async function startScanAgain() {
  startMessage.value = ''
  stopScanPoll()
  const baselineFinishedAt = lastFinished.value?.finishedAt ?? null
  startBusy.value = true
  try {
    const res = await fetch('/__jobsp/api/start-scan', { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      startMessage.value = body.error || `No se pudo arrancar (${res.status})`
      return
    }
    startMessage.value = body.message || 'Scan en curso…'
    liveLogText.value = ''
    report.value = null
    error.value = ''
    loading.value = true
    scanWaiting.value = true
    logPollTimer = setInterval(() => void refreshLiveLog(), 900)
    void refreshLiveLog()
    let attempts = 0
    const tick = async () => {
      if (!scanWaiting.value) return
      try {
        attempts++
        await Promise.all([loadLastFinished(), loadIndex()])
        const finishedNow =
          lastFinished.value?.finishedAt != null &&
          lastFinished.value.finishedAt !== baselineFinishedAt
        const partial = await loadLiveProgressIfPartial()
        if (finishedNow) {
          await loadReport()
        }
        const doneByFinish = finishedNow
        const doneByReport = report.value != null && report.value.partial !== true
        if (doneByFinish || doneByReport || attempts >= POLL_MAX) {
          if (attempts >= POLL_MAX && !doneByReport && !doneByFinish) {
            await loadReport()
          }
          if (attempts >= POLL_MAX) {
            startMessage.value =
              'Sigue sin aparecer el reporte tras ~1 h. Revisá la terminal o logs/scan-*.txt.'
          } else if (doneByReport) {
            startMessage.value = 'Listo: reporte cargado.'
          } else {
            startMessage.value = 'El proceso terminó; revisá el estado arriba o el mensaje de error.'
          }
          stopScanPoll()
          return
        }
      } catch (e) {
        startMessage.value = String(e.message || e)
        stopScanPoll()
        return
      }
      pollTimer = setTimeout(() => void tick(), POLL_MS)
    }
    pollTimer = setTimeout(() => void tick(), 600)
  } catch (e) {
    startMessage.value = String(e.message || e)
  } finally {
    startBusy.value = false
  }
}

async function resetScan() {
  resetMessage.value = ''
  if (
    !confirm(
      '¿Borrar todos los resultados en public/generated (latest, índice, corridas) y empezar de cero? Esto no toca los JSON del PDF en config/generated.',
    )
  ) {
    return
  }
  resetBusy.value = true
  try {
    const res = await fetch('/__jobsp/api/reset-scan', { method: 'POST' })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.ok) {
      resetMessage.value = body.error || `Error al resetear (${res.status})`
      return
    }
    resetMessage.value = body.message || 'Listo.'
    selectedKey.value = 'latest'
    liveLogText.value = ''
    await Promise.all([loadIndex(), loadLastFinished()])
    await loadReport()
  } catch (e) {
    resetMessage.value = String(e.message || e)
  } finally {
    resetBusy.value = false
  }
}

watch(selectedKey, () => {
  loadReport()
})

function fitLabel(fit) {
  if (fit === 'high') return 'Alto'
  if (fit === 'medium') return 'Medio'
  if (fit === 'low') return 'Bajo'
  return fit || '—'
}

function formatScanLabel(entry) {
  if (!entry?.generatedAt) return entry?.file || '—'
  return new Date(entry.generatedAt).toLocaleString('es')
}

function formatLastFinished(meta) {
  if (!meta?.finishedAt) return ''
  const when = new Date(meta.finishedAt).toLocaleString('es')
  return meta.ok ? `${when} · OK` : `${when} · falló`
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>Jobsp</h1>
      <p class="sub">
        <strong>Entrada:</strong> CV y empresas desde
        <code>config/generated/*-from-pdf.json</code>. El scan (con OpenAI) arma el listado de avisos, filtra por perfil
        <strong>fullstack / frontend</strong>, abre cada URL en Chrome y solo muestra lo que sigue siendo match
        <strong>leyendo el detalle</strong> (evita “Project Manager potable” solo por la página careers).
      </p>
      <div v-if="index.scans?.length" class="picker">
        <label for="scan-select">Ver corrida</label>
        <select id="scan-select" v-model="selectedKey">
          <option value="latest">Última (latest.json)</option>
          <option v-for="s in index.scans" :key="s.generatedAt" :value="s.file">
            {{ formatScanLabel(s) }}
          </option>
        </select>
      </div>
      <div class="scan-actions">
        <p class="last-finished">
          <strong>Último proceso terminó:</strong>
          <template v-if="lastFinished">{{ formatLastFinished(lastFinished) }}</template>
          <template v-else
            ><span class="muted-inline">sin datos (vacío o después de reset)</span></template
          >
        </p>
        <p v-if="lastFinished && !lastFinished.ok && lastFinished.error" class="hint err-inline">
          {{ lastFinished.error }}
        </p>
        <div class="scan-buttons-row">
          <button
            type="button"
            class="btn-start"
            :disabled="startBusy || scanWaiting || resetBusy"
            @click="startScanAgain"
          >
            {{ startBusy ? 'Arrancando…' : scanWaiting ? 'Scan en curso…' : 'Start again' }}
          </button>
          <button type="button" class="btn-refresh" :disabled="loading || resetBusy" @click="refreshResults">
            Actualizar
          </button>
          <button type="button" class="btn-reset" :disabled="resetBusy || scanWaiting" @click="resetScan">
            {{ resetBusy ? 'Reseteando…' : 'Reset job scan' }}
          </button>
        </div>
        <p v-if="scanWaiting" class="hint poll-hint">
          <template v-if="report?.partial && report.scanProgress">
            Resultados parciales en la UI: {{ report.scanProgress.completed }} /
            {{ report.scanProgress.total }} empresas (se actualiza cada pocos segundos).
          </template>
          <template v-else>Esperando resultados (revisión cada pocos segundos)…</template>
        </p>
        <p v-if="startMessage" class="hint start-msg">{{ startMessage }}</p>
        <p v-if="resetMessage" class="hint reset-msg">{{ resetMessage }}</p>
      </div>
    </header>

    <section
      v-if="scanWaiting || liveLogText.length > 0"
      class="card live-log-card"
      aria-live="polite"
    >
      <h2 class="live-log-title">Log en vivo</h2>
      <p class="hint live-log-hint">
        Salida del proceso (stdout/stderr). Se guarda en
        <code>public/generated/live-scan.log</code>.
      </p>
      <pre ref="liveLogPre" class="live-log-pre">{{
        liveLogText || (scanWaiting ? 'Esperando la primera línea…' : '')
      }}</pre>
    </section>

    <main v-if="loading" class="card">Cargando…</main>
    <main v-else-if="error" class="card err">{{ error }}</main>
    <main v-else-if="report" class="stack">
      <section class="card meta">
        <p v-if="report.partial" class="hint partial-banner">
          <strong>Parcial:</strong> el scan sigue; cuando termine se reemplaza por el reporte completo.
        </p>
        <p>
          <strong>Corrida:</strong>
          {{ new Date(report.generatedAt).toLocaleString('es') }}
        </p>
        <p>
          <strong>Análisis:</strong>
          {{ report.usedLLM ? 'OpenAI (OPENAI_API_KEY)' : 'Heurística local (sin API key)' }}
        </p>
        <p v-if="report.concurrency">
          <strong>Chrome en paralelo:</strong>
          {{ report.concurrency }} pestañas
        </p>
        <template v-if="report.dataSources">
          <p class="hint">
            Datos PDF · CV: {{ report.dataSources.cvPdf || '—' }} · Listado:
            {{ report.dataSources.listPdf || '—' }}
          </p>
        </template>
      </section>

      <p v-if="companiesInReport.length === 0" class="card muted empty-report">
        Sin resultados positivos en esta corrida.
      </p>

      <section
        v-for="c in companiesInReport"
        :key="(selectedKey || '') + (c.id || c.name || '') + (c.careersUrl || '')"
        class="card company"
      >
        <div class="company-head">
          <h2>{{ c.name }}</h2>
          <span v-if="c.ok" class="badge ok">OK</span>
          <span v-else class="badge bad">Error</span>
        </div>
        <p v-if="c.careersUrl" class="links">
          <a :href="c.finalUrl || c.careersUrl" target="_blank" rel="noreferrer">{{
            c.finalUrl || c.careersUrl
          }}</a>
        </p>
        <p v-if="!c.ok" class="err-msg">{{ c.error }}</p>
        <template v-else>
          <p v-if="c.summary" class="summary">{{ c.summary }}</p>
          <p v-if="!report.usedLLM && c.heuristicScore != null" class="hint">
            Score heurístico: {{ c.heuristicScore }}
          </p>
          <ul class="roles">
            <li v-for="(r, i) in c.relevantRoles" :key="i">
              <div class="role-title">{{ r.title }}</div>
              <div class="role-meta">
                Encaje: {{ fitLabel(r.fit) }}
                <template v-if="r.verifiedOnDetail">
                  · <span class="tag-verified">Detalle Chrome + IA</span>
                </template>
                <template v-if="r.specificUrl">
                  ·
                  <a :href="r.specificUrl" target="_blank" rel="noreferrer">URL oferta</a>
                </template>
              </div>
              <p v-if="r.reason" class="role-reason">{{ r.reason }}</p>
            </li>
          </ul>
        </template>
      </section>
    </main>
  </div>
</template>

<style>
:root {
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: #0f172a;
  background: #f1f5f9;
  line-height: 1.45;
}
body {
  margin: 0;
}
code {
  font-size: 0.9em;
  background: #e2e8f0;
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}
.header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.75rem;
}
.sub {
  margin: 0 0 1rem;
  color: #475569;
  font-size: 0.95rem;
}
.picker {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.25rem;
}
.picker label {
  font-weight: 600;
  font-size: 0.9rem;
}
.picker select {
  min-width: 14rem;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
  background: #fff;
}
.scan-actions {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e2e8f0;
}
.last-finished {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: #334155;
}
.muted-inline {
  color: #94a3b8;
  font-weight: normal;
}
.err-inline {
  color: #b91c1c;
  margin-top: 0.25rem;
}
.scan-buttons-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.35rem;
  margin-bottom: 0.5rem;
}
.btn-start,
.btn-refresh,
.btn-reset {
  font-size: 0.9rem;
  font-weight: 600;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #0f172a;
  cursor: pointer;
}
.btn-start {
  border-color: #22c55e;
  background: #f0fdf4;
  color: #14532d;
}
.btn-start:hover:not(:disabled) {
  background: #dcfce7;
}
.btn-refresh {
  font-weight: 500;
}
.btn-reset:hover:not(:disabled),
.btn-refresh:hover:not(:disabled) {
  border-color: #94a3b8;
  background: #f8fafc;
}
.btn-start:disabled,
.btn-refresh:disabled,
.btn-reset:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.poll-hint {
  margin: 0.35rem 0 0;
}
.start-msg {
  margin: 0.35rem 0 0;
}
.reset-msg {
  margin: 0.5rem 0 0;
}
.live-log-card {
  margin-bottom: 1rem;
}
.live-log-title {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}
.live-log-hint {
  margin: 0 0 0.5rem;
}
.live-log-pre {
  margin: 0;
  max-height: min(40vh, 320px);
  overflow: auto;
  padding: 0.65rem 0.75rem;
  font-size: 0.72rem;
  line-height: 1.35;
  background: #0f172a;
  color: #e2e8f0;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.card {
  background: #fff;
  border-radius: 10px;
  padding: 1rem 1.15rem;
  box-shadow: 0 1px 2px rgb(15 23 42 / 6%);
}
.card.err {
  border: 1px solid #fecaca;
  color: #991b1b;
}
.meta p {
  margin: 0.25rem 0;
}
.company h2 {
  margin: 0;
  font-size: 1.15rem;
}
.company-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
}
.badge.ok {
  background: #dcfce7;
  color: #166534;
}
.badge.bad {
  background: #fee2e2;
  color: #991b1b;
}
.links {
  margin: 0.5rem 0 0;
  word-break: break-all;
}
.links a {
  color: #2563eb;
}
.err-msg {
  color: #b91c1c;
  margin: 0.5rem 0 0;
}
.summary {
  margin: 0.75rem 0 0;
  color: #334155;
}
.hint {
  font-size: 0.85rem;
  color: #64748b;
  margin: 0.35rem 0 0;
}
.roles {
  margin: 0.75rem 0 0;
  padding-left: 1.1rem;
}
.roles li {
  margin-bottom: 0.75rem;
}
.role-title {
  font-weight: 600;
}
.role-meta {
  font-size: 0.9rem;
  color: #475569;
}
.role-reason {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
  color: #334155;
}
.muted {
  color: #94a3b8;
  font-size: 0.9rem;
  margin: 0.75rem 0 0;
}
.empty-report {
  margin: 0;
}
.tag-verified {
  font-size: 0.75rem;
  font-weight: 600;
  color: #1d4ed8;
  background: #dbeafe;
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
</style>
