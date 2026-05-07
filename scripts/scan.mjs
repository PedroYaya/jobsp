#!/usr/bin/env node
/**
 * Entrada: solo datos extraídos de PDF → config/generated/cv-from-pdf.json y companies-from-pdf.json
 * Cada careersUrl se abre en Chrome vía Puppeteer (DOM real + JS), luego se analiza el texto.
 * Salida: public/generated/scans/…json, latest.json, index.json
 * Logs: logs/scan-<timestamp>.txt (todo el run + resumen al cierre)
 *
 * Uso: npm run scan
 * Opcional .env: OPENAI_API_KEY, JOBSP_CHROME_CHANNEL=chrome, JOBSP_NAV_TIMEOUT_MS,
 * JOBSP_CONCURRENCY=2 (páginas Chrome en paralelo, mismo browser; default 2)
 * JOBSP_MAX_COMPANIES=N (solo las primeras N empresas, para probar sin recorrer todo el PDF)
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

async function analyzeWithOpenAI({ companyName, careersUrl, pageText, cvText }) {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const truncated = pageText.slice(0, 14000)

  const system = `Sos un asistente para búsqueda laboral. Respondé SOLO JSON válido, sin markdown.
El JSON debe tener esta forma exacta:
{"relevantRoles":[{"title":"string","fit":"high|medium|low","reason":"string breve en español","specificUrl":"url absoluta o null"}],"summary":"una línea en español"}`

  const user = `Empresa: ${companyName}
URL careers: ${careersUrl}

CV del candidato:
${cvText.slice(0, 8000)}

Texto extraído de la página de careers (puede incluir ruido):
${truncated}

Listá puestos concretos donde tenga sentido que aplique. Si no hay match razonable, relevantRoles puede ser []. specificUrl solo si encontrás en el texto una URL de esa oferta; si no, null.`

  const res = await httpPostJson(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      temperature: 0.2,
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
  let parsed
  try {
    parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''))
  } catch {
    parsed = { relevantRoles: [], summary: 'No se pudo parsear la respuesta del modelo.' }
  }
  return parsed
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
    log(`  LLM…`)
    const tLlm = Date.now()
    try {
      const ai = await analyzeWithOpenAI({
        companyName: name,
        careersUrl: fetched.finalUrl,
        pageText,
        cvText,
      })
      relevantRoles = Array.isArray(ai?.relevantRoles) ? ai.relevantRoles : []
      summary = typeof ai?.summary === 'string' ? ai.summary : ''
      log(`  LLM OK (${Date.now() - tLlm}ms) roles=${relevantRoles.length}`)
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
