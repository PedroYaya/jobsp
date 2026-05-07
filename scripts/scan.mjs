#!/usr/bin/env node
/**
 * Lee config/companies.json + config/cv.txt, baja cada careersUrl (sin CORS: corre en Node),
 * genera public/report-latest.json para que la app Vue lo muestre.
 *
 * Uso: npm run scan
 * Opcional: OPENAI_API_KEY en .env (carga dotenv manual con readFile si hace falta - Node no load .env by default)
 * Cargamos .env sin dependencia extra:
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

/** GET con redirects (Node 16 no tiene fetch global). */
async function httpGet(urlString, { headers = {}, maxRedirects = 10, timeoutMs = 20000 } = {}) {
  let current = urlString
  for (let hop = 0; hop < maxRedirects; hop++) {
    const u = new URL(current)
    const isHttps = u.protocol === 'https:'
    const body = await new Promise((resolve, reject) => {
      const lib = isHttps ? https : http
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, h: res.headers, raw: Buffer.concat(chunks) }))
        },
      )
      req.on('error', reject)
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('timeout'))
      })
      req.end()
    })
    const code = body.status || 0
    if (code >= 300 && code < 400 && body.h.location) {
      current = new URL(body.h.location, current).href
      continue
    }
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: body.raw.toString('utf8'),
      finalUrl: current,
    }
  }
  return { ok: false, status: 0, text: '', finalUrl: current, error: 'Demasiados redirects' }
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

async function fetchCareers(url) {
  try {
    const res = await httpGet(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; Jobsp/0.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'es,en;q=0.9',
      },
    })
    if (res.error) {
      return { ok: false, status: res.status, html: '', error: res.error, finalUrl: res.finalUrl }
    }
    return { ok: res.ok, status: res.status, html: res.text, finalUrl: res.finalUrl }
  } catch (e) {
    return { ok: false, status: 0, html: '', error: String(e.message || e), finalUrl: url }
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

function log(...args) {
  const ts = new Date().toISOString()
  console.log(`[jobsp ${ts}]`, ...args)
}

async function main() {
  await loadDotEnv()

  const [companiesRaw, cvText] = await Promise.all([
    readFile(join(root, 'config', 'companies.json'), 'utf8'),
    readFile(join(root, 'config', 'cv.txt'), 'utf8'),
  ])
  const companies = JSON.parse(companiesRaw)
  const generatedAt = new Date().toISOString()
  const useLLM = Boolean(process.env.OPENAI_API_KEY)

  log('Inicio scan')
  log(`Empresas en config: ${companies.length}`)
  log(`CV: ${cvText.trim().length} caracteres (${join(root, 'config', 'cv.txt')})`)
  log(`Análisis: ${useLLM ? 'OpenAI (OPENAI_API_KEY)' : 'heurística local (sin API key)'}`)

  const results = []
  const total = companies.length
  for (let idx = 0; idx < companies.length; idx++) {
    const c = companies[idx]
    const n = idx + 1
    const name = c.name || c.id || 'Sin nombre'
    const url = c.careersUrl || c.url
    if (!url) {
      log(`[${n}/${total}] ${name} — omitido: falta careersUrl`)
      results.push({
        id: c.id,
        name,
        careersUrl: null,
        ok: false,
        error: 'Falta careersUrl',
        relevantRoles: [],
        summary: '',
        heuristicScore: 0,
      })
      continue
    }

    log(`[${n}/${total}] ${name}`)
    log(`  GET ${url}`)
    const tFetch = Date.now()
    const fetched = await fetchCareers(url)
    const fetchMs = Date.now() - tFetch
    if (!fetched.ok) {
      log(`  falló descarga (${fetchMs}ms) status=${fetched.status} ${fetched.error || ''}`)
      results.push({
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
      })
      continue
    }

    log(`  OK (${fetchMs}ms) finalUrl=${fetched.finalUrl} html≈${fetched.html.length} chars`)

    const pageText = htmlToText(fetched.html)
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

    results.push({
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
    })
    log(`  fin empresa · roles sugeridos=${relevantRoles.length}`)
  }

  const out = {
    generatedAt,
    usedLLM: useLLM,
    companies: results,
  }

  const publicDir = join(root, 'public')
  await mkdir(publicDir, { recursive: true })
  await writeFile(join(publicDir, 'report-latest.json'), JSON.stringify(out, null, 2), 'utf8')
  log(`Escrito public/report-latest.json (${results.length} empresas)`)
  log('Scan terminado')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
