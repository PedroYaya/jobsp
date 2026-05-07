#!/usr/bin/env node
/**
 * Entrada: solo datos extraídos de PDF → config/generated/cv-from-pdf.json y companies-from-pdf.json
 * Chrome abre la página listado; con LLM se extraen avisos, se filtra por perfil técnico (fullstack/frontend),
 * luego se abre cada URL de detalle y la IA confirma o descarta (evita PM “potable” solo por título).
 * Salida: public/generated/scans/…json, latest.json, index.json, last-finished.json (al cerrar, ok o error)
 * Logs: logs/scan-<timestamp>.txt (todo el run + resumen al cierre)
 *
 * Uso: npm run scan
 * Opcional .env: OPENAI_API_KEY, JOBSP_CHROME_CHANNEL=chrome, JOBSP_NAV_TIMEOUT_MS,
 * JOBSP_CONCURRENCY=2 (páginas Chrome en paralelo, mismo browser; default 2)
 * JOBSP_MAX_COMPANIES=N (solo las primeras N empresas, para probar sin recorrer todo el PDF)
 * JOBSP_CANDIDATE_PROFILE (texto libre, perfil buscado; default fullstack con foco frontend)
 * JOBSP_MAX_DETAIL_VISITS=N (máx URLs de detalle a abrir por empresa, default 5)
 * JOBSP_LIST_TITLE_KEYWORDS=a,b (extra para ponderar títulos en el listado)
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import https from 'node:https'
import puppeteer from 'puppeteer'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

let logFilePath = null
let logWriteQueue = Promise.resolve()

async function initRunLog(generatedAt) {
  const logsDir = join(root, 'logs')
  await mkdir(logsDir, { recursive: true })
  logFilePath = join(logsDir, `scan-${generatedAt.replace(/:/g, '-')}.txt`)
  const header =
    `=== Jobsp scan ===\n` +
    `inicio (UTC): ${generatedAt}\n` +
    `cwd: ${root}\n` +
    `node: ${process.version}\n` +
    `${'='.repeat(48)}\n\n`
  await writeFile(logFilePath, header, 'utf8')
  logWriteQueue = Promise.resolve()
}

function log(...args) {
  const ts = new Date().toISOString()
  const msg = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
  console.log(`[jobsp ${ts}]`, ...args)
  const line = `[jobsp ${ts}] ${msg}\n`
  if (logFilePath) {
    logWriteQueue = logWriteQueue.then(() => appendFile(logFilePath, line, 'utf8'))
  }
}

async function flushRunLog() {
  await logWriteQueue.catch(() => {})
}

async function appendRunSummary(results, concurrency, useLLM, err) {
  await flushRunLog()
  if (!logFilePath) return
  const ok = results.filter((r) => r.ok).length
  const fail = results.filter((r) => !r.ok && r.careersUrl).length
  const skip = results.filter((r) => !r.careersUrl).length
  const withRoles = results.filter((r) => r.ok && Array.isArray(r.relevantRoles) && r.relevantRoles.length > 0).length
  const highFit = results.filter((r) =>
    (r.relevantRoles || []).some((x) => x.fit === 'high'),
  ).length
  let block =
    `\n${'='.repeat(48)}\nRESUMEN\n${'='.repeat(48)}\n` +
    `empresas en lista: ${results.length}\n` +
    `OK (página cargada): ${ok}\n` +
    `fallos (Chrome/red): ${fail}\n` +
    `sin URL en config: ${skip}\n` +
    `con ≥1 rol sugerido: ${withRoles}\n` +
    `con algún rol fit=high: ${highFit}\n` +
    `concurrencia JOBSP_CONCURRENCY: ${concurrency}\n` +
    `LLM: ${useLLM ? 'sí' : 'no'}\n`
  if (err) {
    block += `\nERROR (corrida abortada o incompleta):\n${String(err.message || err)}\n`
  }
  block += `\nfin log (UTC): ${new Date().toISOString()}\n`
  await appendFile(logFilePath, block, 'utf8')
}

function httpPostJson(urlString, jsonBody, { headers = {}, timeoutMs = 120000 } = {}) {
  const u = new URL(urlString)
  const payload = JSON.stringify(jsonBody)
  const h = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: h,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.write(payload)
    req.end()
  })
}

async function loadDotEnv() {
  try {
    const raw = await readFile(join(root, '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i === -1) continue
      const k = t.slice(0, i).trim()
      let v = t.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1)
      if (!(k in process.env)) process.env[k] = v
    }
  } catch {
    // sin .env
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü+#.\s-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
}

function heuristicScore(cvText, pageText) {
  const cvTokens = new Set(tokenize(cvText))
  const pageTokens = tokenize(pageText)
  if (!pageTokens.length) return 0
  let hits = 0
  for (const t of pageTokens) {
    if (cvTokens.has(t)) hits++
  }
  return Math.min(1, hits / Math.max(80, pageTokens.length * 0.15))
}

async function launchBrowser() {
  const channel = process.env.JOBSP_CHROME_CHANNEL?.trim()
  const exec = process.env.PUPPETEER_EXECUTABLE_PATH?.trim()
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--mute-audio',
      '--disable-extensions',
      '--window-size=1365,900',
    ],
  }
  if (exec) opts.executablePath = exec
  else if (channel) opts.channel = channel
  return puppeteer.launch(opts)
}

/**
 * Una pestaña nueva por URL: navega como Chrome, devuelve HTML + innerText del DOM renderizado.
 */
async function fetchCareersWithChrome(browser, url) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1365, height: 900 })
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )
    const navTimeout = Number(process.env.JOBSP_NAV_TIMEOUT_MS) || 45000
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout })
    const status = response?.status() ?? 0
    const finalUrl = page.url()
    const postWait = Math.min(8000, Math.max(0, Number(process.env.JOBSP_POST_WAIT_MS) || 2500))
    if (postWait) await new Promise((r) => setTimeout(r, postWait))
    const innerText = await page.evaluate(() => {
      try {
        return document.body ? document.body.innerText : ''
      } catch {
        return ''
      }
    })
    const html = await page.content()
    const ok = status >= 200 && status < 400
    return {
      ok,
      status,
      html,
      innerText: String(innerText || '').trim(),
      finalUrl,
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      html: '',
      innerText: '',
      error: String(e.message || e),
      finalUrl: url,
    }
  } finally {
    await page.close().catch(() => {})
  }
}

function candidateProfile() {
  const custom = process.env.JOBSP_CANDIDATE_PROFILE?.trim()
  if (custom) return custom
  return (
    'Perfil buscado: desarrollador/a fullstack con foco principal en frontend (JavaScript/TypeScript, React, Vue u otro framework web, UI, consumo de APIs). ' +
    'Aplican ingeniería fullstack web y roles con implementación de producto. ' +
    'No aplica liderar proyectos sin código, ni perfiles puramente de negocio o people management.'
  )
}

/** Criterios de título en la vista listado (priorizar estos patrones al shortlistear). */
function listTitlePositiveCriteria() {
  let s =
    'En el LISTADO, priorizá avisos cuyo título suene a rol de implementación / ingeniería de software (inglés o español). ' +
    'Palabras y familias útiles (no exhaustivo; combinaciones cuentan): ' +
    'Fullstack, Full-stack, Frontend, Front-end, FE, Backend, BE, Software, SWE, Engineer, Engineering, Developer, Desarrollador, Programador, Dev, Web, UI Engineer, ' +
    'Application engineer, Staff / Principal / Senior / Mid / Junior / Graduate engineer, Tech Lead / Team Lead (si suena a IC con código), Platform engineer, ' +
    'DevOps engineer, SRE (con implementación), API engineer, Mobile / iOS / Android developer, JavaScript / TypeScript / React / Vue / Angular, SDE, MTS, ' +
    '"Member of Technical Staff", Programmer, Coder, Hacker (en contexto dev), Build engineer, Release engineer, Site engineer (web). ' +
    'Evitá confundir "Engineer" en "Sales Engineer" o "Solutions Engineer" si el título es claramente preventa/ventas sin stack.'
  const extra = process.env.JOBSP_LIST_TITLE_KEYWORDS?.trim()
  if (extra) s += ` Priorizá también títulos que contengan (además del CV): ${extra}.`
  return s
}

function resolveJobHref(href, base) {
  try {
    const u = new URL(String(href).trim(), base)
    if (!/^https?:$/i.test(u.protocol)) return null
    return u.href.replace(/\/$/, '')
  } catch {
    return null
  }
}

async function openaiParseJson(model, system, user) {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('Falta OPENAI_API_KEY')
  const res = await httpPostJson(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    { headers: { authorization: `Bearer ${key}` } },
  )
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OpenAI ${res.status}: ${res.text.slice(0, 400)}`)
  }
  const data = JSON.parse(res.text)
  const content = data.choices?.[0]?.message?.content?.trim() || '{}'
  try {
    return JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''))
  } catch {
    return {}
  }
}

async function llmExtractOpeningsWithUrls(companyName, listUrl, pageText) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const system = `Sos un extractor de listados de empleo. Respondé SOLO JSON válido, sin markdown.
Formato: {"openings":[{"title":"string","url":"string|null"}]}
- title: nombre del puesto o aviso.
- url: enlace al detalle si aparece en el texto (http(s) o ruta /...). Si no hay URL clara para esa fila, null.
Máximo 45 filas. Si no hay listado reconocible: {"openings":[]}.`

  const user = `Empresa: ${companyName}
URL de esta página (base para resolver rutas relativas): ${listUrl}

Texto visible de la página:
${pageText.slice(0, 24000)}`

  const parsed = await openaiParseJson(model, system, user)
  const raw = Array.isArray(parsed.openings) ? parsed.openings : []
  const out = []
  for (const row of raw) {
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const hrefRaw = typeof row.url === 'string' ? row.url.trim() : ''
    if (!title) continue
    if (!hrefRaw) {
      out.push({ title, url: null })
      continue
    }
    const abs = resolveJobHref(hrefRaw, listUrl)
    if (abs) out.push({ title, url: abs })
    else out.push({ title, url: null })
  }
  return out
}

async function llmShortlistTechnicalRoles(openingsWithUrl, cvText, profile, maxShort) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const titleHints = listTitlePositiveCriteria()
  const system = `Sos filtro estricto (solo ingeniería de software alineada al perfil). Respondé SOLO JSON:
{"shortlist":[{"title":"string","url":"string","why":"máx 140 chars español"}]}
Máximo ${maxShort} ítems. Cada url DEBE ser exactamente una de las URLs del input (no inventar dominios).

CRITERIO VISTA LISTADO (título del aviso):
${titleHints}

INCLUIR solo si el título encaja con implementación / código según lo anterior y el perfil+CV.

EXCLUIR SIEMPRE aunque el título sea ambiguo:
- Project / Program / Product Manager, Delivery Manager, TPM no dev
- Scrum Master, Agile coach puro
- Product Owner sin hands-on-code
- Sales, AE, Marketing, BD, Customer Success no técnico
- Recruiter, HR, People, Talent
- Finance, Legal, Ops sin engineering
- Diseño UX/UI puro sin código
- QA manual sin automatización/código

Si ninguno encaja: {"shortlist":[]}.`

  const user = `Perfil buscado:
${profile}

CV (extracto):
${cvText.slice(0, 9000)}

Entradas (solo podés devolver URLs que aparezcan acá):
${JSON.stringify(openingsWithUrl.slice(0, 65))}`

  const parsed = await openaiParseJson(model, system, user)
  const raw = Array.isArray(parsed.shortlist) ? parsed.shortlist : []
  const allowedUrls = new Set(openingsWithUrl.map((o) => o.url))
  const seen = new Set()
  const out = []
  for (const row of raw) {
    const url = typeof row.url === 'string' ? row.url.trim() : ''
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const why = typeof row.why === 'string' ? row.why.trim() : ''
    if (!url || seen.has(url) || !allowedUrls.has(url)) continue
    seen.add(url)
    out.push({ title, url, why })
    if (out.length >= maxShort) break
  }
  return out
}

async function llmVerifyDetailPage({ detailText, cvText, profile, listTitle, jobUrl }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const system = `Sos auditor estricto aviso vs candidato. SOLO JSON:
{"include":true|false,"title":"string","fit":"high|medium|low","reason":"español conciso","redFlags":"texto o vacío"}

include=true SOLO si el TEXTO del aviso describe trabajo principalmente de ingeniería software (implementación) acorde al perfil y al CV.

include=false si el detalle es gestión/PM/PO/ventas/people, "stakeholder" como rol principal sin stack, consulting funcional, o el título decía dev pero el cuerpo no.`

  const user = `Perfil buscado:
${profile}

CV (extracto):
${cvText.slice(0, 8000)}

URL: ${jobUrl}
Título en listado: ${listTitle}

Detalle del aviso:
${detailText.slice(0, 16000)}`

  return openaiParseJson(model, system, user)
}

async function analyzeListPageFallbackStrict({ companyName, careersUrl, pageText, cvText }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const profile = candidateProfile()
  const system = `No hay URLs de avisos parseables; analizás solo texto general de careers. SOLO JSON:
{"relevantRoles":[{"title":"string","fit":"high|medium|low","reason":"","specificUrl":"string|null"}],"summary":"una línea"}

Solo roles de ingeniería software (front/fullstack/web) si están explícitos. NO Project Manager, PM, PO, Scrum, ventas, marketing, HR. Si no hay señal dev clara: [].`

  const user = `Empresa: ${companyName} · ${careersUrl}
Perfil: ${profile}

CV:
${cvText.slice(0, 7000)}

Página:
${pageText.slice(0, 12000)}`

  return openaiParseJson(model, system, user)
}

async function analyzeWithListAndDetailPages(browser, { companyName, careersUrl, finalUrl, pageText, cvText }) {
  const profile = candidateProfile()
  const maxVisit = Math.min(10, Math.max(1, Number(process.env.JOBSP_MAX_DETAIL_VISITS) || 5))

  const openings = await llmExtractOpeningsWithUrls(companyName, finalUrl, pageText)
  const withUrl = openings.filter((o) => o.url)
  log(`  LLM: ${openings.length} filas listado (${withUrl.length} con URL)`)

  if (withUrl.length === 0) {
    log('  Sin URLs en listado → análisis estricto solo sobre texto de la página')
    const fb = await analyzeListPageFallbackStrict({ companyName, careersUrl: finalUrl, pageText, cvText })
    return {
      relevantRoles: Array.isArray(fb.relevantRoles) ? fb.relevantRoles : [],
      summary: typeof fb.summary === 'string' ? fb.summary : '',
    }
  }

  const shortlist = await llmShortlistTechnicalRoles(withUrl, cvText, profile, maxVisit)
  log(`  LLM: shortlist técnica ${shortlist.length} (máx ${maxVisit})`)

  if (shortlist.length === 0) {
    return {
      relevantRoles: [],
      summary:
        'Hay avisos con URL pero ninguno pasó el filtro de ingeniería (p. ej. PM/PO/roles no dev excluidos).',
    }
  }

  const relevantRoles = []
  for (let i = 0; i < shortlist.length; i++) {
    const s = shortlist[i]
    log(`    Chrome detalle [${i + 1}/${shortlist.length}]`)
    const det = await fetchCareersWithChrome(browser, s.url)
    if (!det.ok) {
      log(`    detalle falló: ${det.error || det.status}`)
      continue
    }
    const detailText =
      det.innerText && det.innerText.length > 200 ? det.innerText : htmlToText(det.html || '')
    let verdict
    try {
      verdict = await llmVerifyDetailPage({
        detailText,
        cvText,
        profile,
        listTitle: s.title,
        jobUrl: s.url,
      })
    } catch (e) {
      log(`    error verificación: ${e.message}`)
      continue
    }
    if (verdict.include !== true) {
      log(`    descartado post-detalle: ${verdict.reason || verdict.redFlags || '—'}`)
      continue
    }
    relevantRoles.push({
      title: verdict.title || s.title,
      fit: ['high', 'medium', 'low'].includes(verdict.fit) ? verdict.fit : 'medium',
      reason:
        String(verdict.reason || '').trim() +
        (s.why ? ` · Listado: ${s.why}` : '') +
        (verdict.redFlags ? ` · ${verdict.redFlags}` : ''),
      specificUrl: s.url,
      verifiedOnDetail: true,
    })
  }

  const summary =
    relevantRoles.length > 0
      ? `Se abrieron ${shortlist.length} avisos en detalle; ${relevantRoles.length} recomendables tras verificar el texto completo.`
      : 'Se revisaron avisos en detalle; ninguno cumplió criterio estricto de ingeniería para tu perfil.'
  return { relevantRoles, summary }
}

/** Varias pestañas a la vez; mismo proceso Node = sin race en el contador. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const idx = next++
      if (idx >= items.length) break
      results[idx] = await fn(items[idx], idx)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

async function scanOneCompany(browser, c, idx, total, cvText, useLLM) {
  const n = idx + 1
  const name = c.name || c.id || 'Sin nombre'
  const url = c.careersUrl || c.url
  if (!url) {
    log(`[${n}/${total}] ${name} — omitido: falta careersUrl`)
    return {
      id: c.id,
      name,
      careersUrl: null,
      ok: false,
      error: 'Falta careersUrl',
      relevantRoles: [],
      summary: '',
      heuristicScore: 0,
    }
  }

  log(`[${n}/${total}] ${name}`)
  log(`  Chrome → ${url}`)
  const tFetch = Date.now()
  const fetched = await fetchCareersWithChrome(browser, url)
  const fetchMs = Date.now() - tFetch
  if (!fetched.ok) {
    log(`  falló descarga (${fetchMs}ms) status=${fetched.status} ${fetched.error || ''}`)
    return {
      id: c.id,
      name,
      careersUrl: url,
      finalUrl: fetched.finalUrl,
      ok: false,
      status: fetched.status,
      error: fetched.error || `HTTP ${fetched.status}`,
      relevantRoles: [],
      summary: '',
      heuristicScore: 0,
    }
  }

  log(
    `  OK (${fetchMs}ms) finalUrl=${fetched.finalUrl} innerText≈${fetched.innerText?.length || 0} html≈${fetched.html?.length || 0}`,
  )

  const pageText =
    fetched.innerText && fetched.innerText.length > 120 ? fetched.innerText : htmlToText(fetched.html || '')
  const hScore = heuristicScore(cvText, pageText)
  log(`  texto plano≈${pageText.length} chars · score heurístico=${Number(hScore.toFixed(3))}`)

  let relevantRoles = []
  let summary = ''

  if (useLLM) {
    log(`  LLM (listado → filtro técnico → detalle Chrome → verificación)`)
    const tLlm = Date.now()
    try {
      const ai = await analyzeWithListAndDetailPages(browser, {
        companyName: name,
        careersUrl: url,
        finalUrl: fetched.finalUrl,
        pageText,
        cvText,
      })
      relevantRoles = Array.isArray(ai?.relevantRoles) ? ai.relevantRoles : []
      summary = typeof ai?.summary === 'string' ? ai.summary : ''
      log(`  LLM OK (${Date.now() - tLlm}ms) roles verificados=${relevantRoles.length}`)
    } catch (e) {
      summary = `Error LLM: ${e.message}`
      log(`  LLM error (${Date.now() - tLlm}ms): ${e.message}`)
    }
  }

  if (!useLLM || (!relevantRoles.length && !summary)) {
    summary =
      hScore > 0.12
        ? 'Coincidencia leve por palabras clave entre tu CV y la página (sin LLM). Revisá la URL.'
        : 'Poca coincidencia por palabras clave (sin LLM). Igual puede haber roles relevantes en SPAs o PDFs.'
    if (!useLLM && hScore > 0.08) {
      relevantRoles = [
        {
          title: 'Revisar listado en careers',
          fit: hScore > 0.15 ? 'medium' : 'low',
          reason: 'Heurística por solapamiento de términos con tu CV. Configurá OPENAI_API_KEY para análisis fino.',
          specificUrl: fetched.finalUrl,
        },
      ]
    }
  }

  log(`  fin empresa · roles sugeridos=${relevantRoles.length}`)
  return {
    id: c.id,
    name,
    careersUrl: url,
    finalUrl: fetched.finalUrl,
    ok: true,
    status: fetched.status,
    heuristicScore: Number(hScore.toFixed(3)),
    usedLLM: useLLM,
    relevantRoles,
    summary,
  }
}

const genConfigDir = join(root, 'config', 'generated')
const pathCompaniesPdf = join(genConfigDir, 'companies-from-pdf.json')
const pathCvPdf = join(genConfigDir, 'cv-from-pdf.json')

async function main() {
  await loadDotEnv()

  let companiesRaw
  let cvJsonRaw
  try {
    ;[companiesRaw, cvJsonRaw] = await Promise.all([readFile(pathCompaniesPdf, 'utf8'), readFile(pathCvPdf, 'utf8')])
  } catch {
    console.error(
      `[jobsp] Faltan JSON exportados desde PDF:\n  ${pathCompaniesPdf}\n  ${pathCvPdf}\n` +
        `Generarlos con: npm run import-pdfs`,
    )
    process.exit(1)
  }

  const listPack = JSON.parse(companiesRaw)
  let companies = Array.isArray(listPack.companies) ? listPack.companies : []
  const companiesTotalInPdf = companies.length
  const cvPack = JSON.parse(cvJsonRaw)
  const cvText = typeof cvPack.plainText === 'string' ? cvPack.plainText : ''
  if (!cvText.trim()) {
    console.error(`[jobsp] ${pathCvPdf} no tiene plainText.`)
    process.exit(1)
  }

  const generatedAt = new Date().toISOString()
  const useLLM = Boolean(process.env.OPENAI_API_KEY)

  await initRunLog(generatedAt)
  log(`Archivo de log: ${logFilePath}`)

  const rawMax = Number(process.env.JOBSP_MAX_COMPANIES)
  if (Number.isFinite(rawMax) && rawMax > 0) {
    const n = Math.min(Math.floor(rawMax), companies.length)
    companies = companies.slice(0, n)
    log(`JOBSP_MAX_COMPANIES activo: escaneando ${companies.length} de ${companiesTotalInPdf}`)
  }

  log('Inicio scan')
  log(`Entrada (PDF): ${pathCompaniesPdf} + ${pathCvPdf}`)
  log(`Listado PDF: ${listPack.sourceFile || '?'} · CV PDF: ${cvPack.sourceFile || '?'}`)
  log(`Empresas a escanear: ${companies.length}${companies.length < companiesTotalInPdf ? ` (lista PDF: ${companiesTotalInPdf})` : ''}`)
  log(`CV: ${cvText.trim().length} caracteres`)
  log(`Análisis: ${useLLM ? 'OpenAI (OPENAI_API_KEY)' : 'heurística local (sin API key)'}`)

  const rawConc = Number(process.env.JOBSP_CONCURRENCY)
  const concurrency = Number.isFinite(rawConc) ? Math.max(1, Math.min(8, Math.floor(rawConc))) : 2
  log(`Páginas Chrome en paralelo: ${concurrency} (JOBSP_CONCURRENCY)`)

  let browser
  let results = []
  let lastErr = null
  let relScanFile = null
  const total = companies.length
  try {
    log('Lanzando Chrome (Puppeteer)…')
    try {
      browser = await launchBrowser()
    } catch (e) {
      const msg = String(e.message || e)
      if (msg.includes('Could not find Chrome') || msg.includes('browser')) {
        log('No está instalado el Chrome de Puppeteer. En la raíz del repo: npm run puppeteer:install')
      }
      throw e
    }

    results = await mapWithConcurrency(companies, concurrency, (c, idx) =>
      scanOneCompany(browser, c, idx, total, cvText, useLLM),
    )

    const out = {
      generatedAt,
      usedLLM: useLLM,
      concurrency,
      dataSources: {
        cvPdf: cvPack.sourceFile || null,
        cvExportedAt: cvPack.generatedAt || null,
        listPdf: listPack.sourceFile || null,
        listExportedAt: listPack.generatedAt || null,
        companiesCount: companies.length,
        companiesTotalInPdf,
      },
      companies: results,
    }

    const json = JSON.stringify(out, null, 2)
    const publicDir = join(root, 'public')
    const genPublic = join(publicDir, 'generated')
    const scansDir = join(genPublic, 'scans')
    await mkdir(scansDir, { recursive: true })

    const scanFile = `scan-${generatedAt.replace(/:/g, '-')}.json`
    const relScan = `scans/${scanFile}`
    await writeFile(join(scansDir, scanFile), json, 'utf8')
    await writeFile(join(genPublic, 'latest.json'), json, 'utf8')

    let index = { scans: [] }
    try {
      index = JSON.parse(await readFile(join(genPublic, 'index.json'), 'utf8'))
    } catch {
      /* primer corrida */
    }
    const scans = Array.isArray(index.scans) ? index.scans : []
    const entry = { file: relScan, generatedAt }
    const next = [entry, ...scans.filter((s) => s.generatedAt !== generatedAt)].slice(0, 100)
    await writeFile(join(genPublic, 'index.json'), JSON.stringify({ scans: next }, null, 2), 'utf8')

    relScanFile = relScan

    log(`Salida (esta corrida): public/generated/${relScan}`)
    log(`Salida latest: public/generated/latest.json`)
    log(`Índice: public/generated/index.json (${next.length} corridas)`)
    log('Scan terminado')
  } catch (e) {
    lastErr = e
    console.error('[jobsp] Error durante el scan:', e.message || e)
    log(`ERROR: ${e.message || e}`)
    process.exitCode = 1
  } finally {
    const genPublic = join(root, 'public', 'generated')
    try {
      await mkdir(genPublic, { recursive: true })
      const finishedAt = new Date().toISOString()
      const meta = {
        finishedAt,
        ok: !lastErr,
        runStartedAt: generatedAt,
        latestScanFile: lastErr ? null : relScanFile,
        error: lastErr ? String(lastErr.message || lastErr) : null,
      }
      await writeFile(join(genPublic, 'last-finished.json'), JSON.stringify(meta, null, 2), 'utf8')
      log(`Fin de proceso registrado: public/generated/last-finished.json (${finishedAt}, ok=${meta.ok})`)
    } catch (metaErr) {
      console.error('[jobsp] No se pudo escribir last-finished.json:', metaErr.message || metaErr)
    }
    try {
      await appendRunSummary(results, concurrency, useLLM, lastErr)
      log(`Resumen agregado al log: ${logFilePath}`)
    } catch (logErr) {
      console.error('[jobsp] No se pudo escribir resumen en log:', logErr.message || logErr)
    }
    await flushRunLog()
    if (browser) await browser.close().catch(() => {})
  }
  if (lastErr) throw lastErr
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
