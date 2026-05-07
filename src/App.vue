<script setup>
import { computed, onMounted, ref, watch } from 'vue'

const loading = ref(true)
const error = ref('')
const report = ref(null)
const index = ref({ scans: [] })
const selectedKey = ref('latest')

const reportUrl = computed(() => {
  if (selectedKey.value === 'latest') return '/generated/latest.json'
  const file = selectedKey.value
  if (!file) return '/generated/latest.json'
  return `/generated/${file}`
})

async function loadReport() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(reportUrl.value, { cache: 'no-store' })
    if (!res.ok) {
      error.value =
        res.status === 404
          ? 'No hay reportes todavía. Ejecutá npm run scan (los datos vienen de config/generated/*-from-pdf.json).'
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

onMounted(async () => {
  try {
    const idxRes = await fetch('/generated/index.json', { cache: 'no-store' })
    if (idxRes.ok) index.value = await idxRes.json()
  } catch {
    /* sin índice aún */
  }
  await loadReport()
})

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
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>Jobsp</h1>
      <p class="sub">
        <strong>Entrada:</strong> CV y empresas solo desde
        <code>config/generated/*-from-pdf.json</code> (exportados del PDF).
        <strong>Estos reportes:</strong> cada <code>npm run scan</code> guarda un archivo en
        <code>public/generated/</code> para revisar después qué te interesó.
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
    </header>

    <main v-if="loading" class="card">Cargando…</main>
    <main v-else-if="error" class="card err">{{ error }}</main>
    <main v-else-if="report" class="stack">
      <section class="card meta">
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

      <section
        v-for="c in report.companies"
        :key="(selectedKey || '') + (c.id || c.name)"
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
          <ul v-if="c.relevantRoles?.length" class="roles">
            <li v-for="(r, i) in c.relevantRoles" :key="i">
              <div class="role-title">{{ r.title }}</div>
              <div class="role-meta">
                Encaje: {{ fitLabel(r.fit) }}
                <template v-if="r.specificUrl">
                  ·
                  <a :href="r.specificUrl" target="_blank" rel="noreferrer">URL oferta</a>
                </template>
              </div>
              <p v-if="r.reason" class="role-reason">{{ r.reason }}</p>
            </li>
          </ul>
          <p v-else class="muted">Sin roles sugeridos para esta empresa.</p>
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
</style>
