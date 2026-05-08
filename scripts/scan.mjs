#!/usr/bin/env node
/**
 * Entrada: solo datos extraídos de PDF → config/generated/cv-from-pdf.json y companies-from-pdf.json
 * Chrome abre la página listado; con LLM se extraen avisos, se filtra por perfil técnico (fullstack/frontend),
 * luego se abre cada URL de detalle y la IA confirma o descarta (evita PM “potable” solo por título).
 * Salida: public/generated/scans/…json, latest.json, live-progress.json (parcial durante el scan), index.json, last-finished.json (al cerrar, ok o error)
 * Logs: logs/scan-<timestamp>.txt (todo el run + resumen al cierre)
 *
 * Uso: npm run scan
 * Opcional .env: OPENAI_API_KEY, JOBSP_CHROME_CHANNEL=chrome, JOBSP_NAV_TIMEOUT_MS,
 * JOBSP_CONCURRENCY=2 (páginas Chrome en paralelo, mismo browser; default 2)
 * JOBSP_MAX_COMPANIES=N (solo las primeras N empresas, para probar sin recorrer todo el PDF)
 * JOBSP_CANDIDATE_PROFILE (texto libre, perfil buscado; default fullstack con foco frontend)
 * JOBSP_MAX_DETAIL_VISITS=N (máx URLs de detalle a abrir por empresa, default 5)
 * JOBSP_LIST_TITLE_KEYWORDS=a,b (extra para ponderar títulos en el listado)
 * JOBSP_JOB_LOCATION_PREFERENCE=texto libre (ubicación/modalidad; si no va, sobrescribe el criterio geográfico por defecto del LLM)
 * Si la URL de careers da 404 (o página “not found”), el scan puede ir a la home del mismo sitio y buscar enlaces career/jobs (footer, nav).
 */
import { readFile, writeFile, mkdir, appendFile, unlink } from 'node:fs/promises'
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

function siteHomeUrl(url) {
  try {
    const u = new URL(String(url).trim())
    return `${u.protocol}//${u.hostname}/`
  } catch {
    return null
  }
}

/** HTTP ok pero cuerpo típico de 404 SPA o página de error corta. */
function looksLikeSoft404(innerText, status) {
  if (status >= 400) return true
  const t = String(innerText || '').trim()
  if (t.length < 120) return true
  const head = t.slice(0, 4500).toLowerCase()
  if (/\b404\b/.test(head) && /\b(not found|no encontrad|doesn'?t exist|could not be found|page introuvable)\b/.test(head))
    return true
  if (t.length < 700 && /\b404\b/.test(head)) return true
  if (/\b(gone|this page isn'?t available|page removed|invalid url)\b/.test(head) && t.length < 2500) return true
  return false
}

function careersPagePayloadUsable(status, innerText) {
  const httpOk = status >= 200 && status < 400
  if (!httpOk) return false
  if (looksLikeSoft404(innerText, status)) return false
  if (String(innerText || '').trim().length < 80) return false
  return true
}

function careersLinkScore(href) {
  const low = String(href || '').toLowerCase()
  let s = 0
  if (/\/(jobs|job|careers|join|hiring|positions|vacancies|life-at|team)\b/.test(low)) s += 45
  if (/career|hiring|join-?us|open-?role|workable|greenhouse|lever\.|ashby|myworkdayjobs|bamboohr|smartrecruiters|icims|jobvite/.test(low))
    s += 35
  if (/linkedin\.|facebook\.|twitter\.|mailto:|tel:/.test(low)) s -= 80
  return s
}

const MAX_CAREERS_RECOVERY_LINKS = 8

/** Tras estar en home (o cualquier página del sitio), enlaces que podrían ser careers/jobs (mismo host). */
async function collectCareersLinksFromRenderedPage(page) {
  const origin = page.url()
  return page.evaluate((pageUrl) => {
    const out = []
    const seen = new Set()
    let base
    try {
      base = new URL(pageUrl)
    } catch {
      return out
    }
    const host = base.hostname
    const roots = new Set()
    for (const sel of [
      'footer',
      '[role="contentinfo"]',
      'header',
      '[role="banner"]',
      'nav',
      '[role="navigation"]',
      '[class*="footer" i]',
      '[id*="footer" i]',
    ]) {
      document.querySelectorAll(sel).forEach((el) => roots.add(el))
    }
    if (!roots.size) roots.add(document.body)
    const consider = (root) => {
      if (!root?.querySelectorAll) return
      root.querySelectorAll('a[href]').forEach((a) => {
        const raw = (a.getAttribute('href') || '').trim()
        if (!raw || raw.startsWith('#') || raw.toLowerCase().startsWith('javascript:')) return
        let abs
        try {
          abs = new URL(raw, base.origin).href
        } catch {
          return
        }
        let hostAbs
        try {
          hostAbs = new URL(abs).hostname
        } catch {
          return
        }
        if (hostAbs !== host) return
        if (seen.has(abs)) return
        const path = new URL(abs).pathname.toLowerCase()
        const full = abs.toLowerCase()
        const hint = `${path} ${full} ${(a.textContent || '').slice(0, 80).toLowerCase()}`
        if (
          /(career|\/jobs|\/job\/|\/job\b|hiring|join[\s_-]?(us|team)|open[\s_-]?roles?|we[\u2019']?re hiring|empleo|work[\s_-]with|life[\s_-]at|vacante|reclutamiento|equipo)/.test(
            hint,
          ) ||
          /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workable\.com|bamboohr\.com|smartrecruiters\.com|icims\.com|jobvite\.com)/.test(
            full,
          )
        ) {
          if (/(login|signin|signup|sign-up|privacy|terms|cookie|legal)(\/|$)/.test(path)) return
          seen.add(abs)
          out.push(abs)
        }
      })
    }
    for (const r of roots) consider(r)
    if (out.length < 4 && document.body) consider(document.body)
    return [...new Set(out)]
  }, origin)
}

/**
 * Una pestaña nueva por URL: navega como Chrome, devuelve HTML + innerText del DOM renderizado.
 * finalUrl = location.href al final (tras postWait) — eso es lo que guardamos como URL de oferta si el aviso pasó verificación.
 * @param {string} [logCtx] — si viene, escribe en el log de corrida líneas [Chrome] para seguir el proceso (p. ej. detalle por aviso).
 * @param {{ recover404FromSite?: boolean }} [opts] — si true y la URL inicial falla (404 / not found / error corto), probá la home y enlaces career del footer/nav (solo para la página principal de careers por empresa).
 */
async function fetchCareersWithChrome(browser, url, logCtx = '', opts = {}) {
  const recover404FromSite = opts.recover404FromSite === true
  const navTimeout = Number(process.env.JOBSP_NAV_TIMEOUT_MS) || 45000
  const postWait = Math.min(8000, Math.max(0, Number(process.env.JOBSP_POST_WAIT_MS) || 2500))

  const page = await browser.newPage()
  const logLine = (msg) => {
    if (logCtx) log(`    [Chrome] ${logCtx} ${msg}`)
    else log(`    [Chrome] ${msg}`)
  }

  try {
    if (logCtx) log(`    [Chrome] ${logCtx} → goto: ${url}`)
    else log(`    [Chrome] → goto: ${url}`)
    await page.setViewport({ width: 1365, height: 900 })
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )

    async function readAfterNavigation(response) {
      const status = response?.status() ?? 0
      if (postWait) await new Promise((r) => setTimeout(r, postWait))
      const innerText = await page.evaluate(() => {
        try {
          return document.body ? document.body.innerText : ''
        } catch {
          return ''
        }
      })
      const html = await page.content()
      const finalUrl = page.url()
      const innerStr = String(innerText || '').trim()
      const usable = careersPagePayloadUsable(status, innerStr)
      return {
        ok: usable,
        status,
        html,
        innerText: innerStr,
        finalUrl,
      }
    }

    let response
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout })
    } catch (e) {
      logLine(`← error navegación: ${String(e.message || e)}`)
      return {
        ok: false,
        status: 0,
        html: '',
        innerText: '',
        error: String(e.message || e),
        finalUrl: url,
      }
    }

    let result = await readAfterNavigation(response)
    const innerLen = result.innerText.length
    if (logCtx) {
      log(
        `    [Chrome] ${logCtx} ← listo: http=${result.status} finalUrl=${result.finalUrl} innerTextChars=${innerLen} postWaitMs=${postWait}`,
      )
    } else {
      log(
        `    [Chrome] ← listo: http=${result.status} finalUrl=${result.finalUrl} innerTextChars=${innerLen} postWaitMs=${postWait}`,
      )
    }

    if (result.ok || !recover404FromSite) {
      return result
    }

    const home = siteHomeUrl(url)
    if (!home || home.replace(/\/$/, '') === String(url).replace(/\/$/, '')) {
      return result
    }

    log(`    [Chrome] recovery: URL careers falló (http=${result.status}, usable=false) → probando home ${home} y enlaces footer/nav…`)
    const tried = new Set([String(url).replace(/\/$/, '')])
    try {
      response = await page.goto(home, { waitUntil: 'domcontentloaded', timeout: navTimeout })
    } catch (e) {
      log(`    [Chrome] recovery: home falló: ${String(e.message || e)}`)
      return result
    }
    await readAfterNavigation(response)
    let candidates = await collectCareersLinksFromRenderedPage(page)
    candidates = [...new Set(candidates)].sort((a, b) => careersLinkScore(b) - careersLinkScore(a))
    candidates = candidates.slice(0, MAX_CAREERS_RECOVERY_LINKS)

    for (const cand of candidates) {
      const key = String(cand).replace(/\/$/, '')
      if (tried.has(key)) continue
      tried.add(key)
      log(`    [Chrome] recovery → probando: ${cand}`)
      try {
        response = await page.goto(cand, { waitUntil: 'domcontentloaded', timeout: navTimeout })
      } catch (e) {
        log(`    [Chrome] recovery ← skip (${String(e.message || e).slice(0, 120)})`)
        continue
      }
      const next = await readAfterNavigation(response)
      if (next.ok) {
        log(`    [Chrome] recovery OK: finalUrl=${next.finalUrl}`)
        return next
      }
    }

    log(`    [Chrome] recovery: sin candidato útil (${candidates.length} enlaces revisados)`)
    return result
  } catch (e) {
    logLine(`← error: ${String(e.message || e)}`)
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

/** Criterio de ubicación/modalidad para el LLM (shortlist + detalle + fallback listado). */
function jobLocationBlock() {
  const custom = process.env.JOBSP_JOB_LOCATION_PREFERENCE?.trim()
  if (custom) {
    return (
      'Instrucción explícita del candidato sobre ubicación y modalidad (prioridad absoluta):\n' +
      custom +
      '\nSi un aviso contradice esto (oficina solo en otro país, “remote US-only”, “must relocate to…”, etc.), excluí el rol del shortlist o poné include=false en detalle y explicá la restricción en reason/redFlags.'
    )
  }
  return (
    'Por defecto el candidato prioriza Latinoamérica y/o trabajo remoto compatible con vivir en LATAM (sin reubicarse a hubs USA/Europa/Asia salvo que el propio aviso abra explícitamente remoto desde LATAM o “remote anywhere / work from anywhere” sin vetar la región). ' +
    'Si el listado o el detalle indica presencial u híbrido solo en ciudades/países fuera de LATAM (p. ej. Chicago, Dublin, Krakow, Londres, Sydney, “office in San Francisco”) y no aclara remoto desde Argentina/LATAM ni remoto global sin restricción, el rol **no** encaja geográficamente: no shortlistear y en verificación de detalle include=false, citando en reason la ciudad/región o la frase restrictiva. ' +
    'Si el puesto es 100% remoto sin restricción de país, o menciona LATAM/South America/Argentina/México/Brasil explícitamente como opción, puede ser apto aunque la empresa tenga oficinas en otros países. ' +
    'Para otro criterio (p. ej. aceptar USA) definí JOBSP_JOB_LOCATION_PREFERENCE en .env con texto libre.'
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
Formato: {"openings":[{"title":"string","url":"string|null","locationHint":"string|null"}]}
- title: nombre del puesto o aviso.
- url: SOLO si en el texto hay un enlace propio a ESE aviso (href de la fila/tarjeta: /jobs/…, ?gh_jid=, /o/, /position/, /job/, /careers/…/… con slug/id, etc.). Debe abrir el detalle de esa oferta, no la vista listado genérica.
- locationHint: si en la misma fila/sección del listado aparece ciudad, país, región o modalidad (Remote, Hybrid, "United States", São Paulo, etc.), resumilo en pocas palabras; si no hay señal, null (no inventes).
- Si el listado no muestra href por fila o solo repetirías la URL base de la página actual para muchas filas, usá null (no inventes ni reutilices la home de careers como url de cada fila).
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
    const hintRaw = typeof row.locationHint === 'string' ? row.locationHint.trim() : ''
    const locationHint = hintRaw ? hintRaw : null
    if (!title) continue
    if (!hrefRaw) {
      out.push({ title, url: null, locationHint })
      continue
    }
    const abs = resolveJobHref(hrefRaw, listUrl)
    if (abs) out.push({ title, url: abs, locationHint })
    else out.push({ title, url: null, locationHint })
  }
  return out
}

async function llmShortlistTechnicalRoles(openingsWithUrl, cvText, profile, maxShort) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const titleHints = listTitlePositiveCriteria()
  const loc = jobLocationBlock()
  const system = `Sos filtro estricto (solo ingeniería de software alineada al perfil). Respondé SOLO JSON:
{"shortlist":[{"title":"string","url":"string","why":"máx 140 chars español"}]}
Máximo ${maxShort} ítems. Cada url DEBE ser exactamente una de las URLs del input (no inventar dominios).
Cada url tiene que ser enlace al DETALLE de ese aviso (página del puesto o URL con id/slug del rol). NO elijas entradas cuya url sea solo la página de listado o /careers sin path de oferta, a menos que el input no tenga otra url para ese título.

CRITERIO VISTA LISTADO (título del aviso):
${titleHints}

UBICACIÓN / MODALIDAD (además del encaje técnico):
${loc}
Si el input trae "locationHint" por fila, usalo: si contradice el criterio geográfico anterior, NO incluyas esa URL en el shortlist (aunque el título sea “Fullstack” u otro rol técnico).

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

Entradas (solo podés devolver URLs que aparezcan acá; cada ítem puede incluir title, url, locationHint):
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
  const loc = jobLocationBlock()
  const system = `Sos auditor estricto aviso vs candidato. SOLO JSON:
{"include":true|false,"title":"string","fit":"high|medium|low","reason":"español conciso","redFlags":"texto o vacío"}

include=true SOLO si el TEXTO del aviso describe trabajo principalmente de ingeniería software (implementación) acorde al perfil y al CV.

include=false si el detalle es gestión/PM/PO/ventas/people, "stakeholder" como rol principal sin stack, consulting funcional, o el título decía dev pero el cuerpo no.

UBICACIÓN Y MODALIDAD (leé el detalle: ciudad/oficina, país, "remote" con restricción, relocation, timezone hiring):
${loc}
include=false si el lugar o las restricciones de remote/reubicación incumplen ese criterio, aunque el stack encaje; en reason citá la frase o ubicación que lo determina (ej. "Chicago office", "US only", "must be in Ireland").`

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

Solo roles de ingeniería software (front/fullstack/web) si están explícitos. NO Project Manager, PM, PO, Scrum, ventas, marketing, HR. Si no hay señal dev clara: [].
Respetá también ubicación/modalidad: no sugieras roles cuyo texto implique solo hubs fuera del criterio geográfico del candidato si no hay remoto LATAM-friendly explícito.`

  const user = `Empresa: ${companyName} · ${careersUrl}
Perfil: ${profile}

${jobLocationBlock()}

CV:
${cvText.slice(0, 7000)}

Página:
${pageText.slice(0, 12000)}`

  return openaiParseJson(model, system, user)
}

async function analyzeWithListAndDetailPages(browser, { companyName, careersUrl, finalUrl, pageText, cvText }) {
  const profile = candidateProfile()
  const maxVisit = Math.min(10, Math.max(1, Number(process.env.JOBSP_MAX_DETAIL_VISITS) || 5))
  log(
    `  [proceso] ${companyName}: pipeline listado→detalle (listado finalUrl=${finalUrl}, hasta ${maxVisit} URLs de detalle, postWait JOBSP_POST_WAIT_MS)`,
  )

  const openings = await llmExtractOpeningsWithUrls(companyName, finalUrl, pageText)
  const withUrl = openings.filter((o) => o.url)
  log(`  LLM: ${openings.length} filas listado (${withUrl.length} con URL)`)

  if (withUrl.length === 0) {
    log('  Sin URLs en listado → análisis estricto solo sobre texto de la página')
    const fb = await analyzeListPageFallbackStrict({ companyName, careersUrl: finalUrl, pageText, cvText })
    const raw = Array.isArray(fb.relevantRoles) ? fb.relevantRoles : []
    const withPageUrl = raw.map((r) => {
      if (!r || typeof r !== 'object') return r
      const fromLlm = typeof r.specificUrl === 'string' ? r.specificUrl.trim() : ''
      const abs = fromLlm ? resolveJobHref(fromLlm, finalUrl) || fromLlm : ''
      return { ...r, specificUrl: abs || finalUrl }
    })
    log(
      `  [proceso/fallback] Sin URLs por fila en el listado. ${withPageUrl.length} roles; specificUrl = página analizada salvo URL del modelo.`,
    )
    for (let ri = 0; ri < withPageUrl.length; ri++) {
      const r = withPageUrl[ri]
      if (r && typeof r === 'object' && r.title)
        log(`    [fallback rol ${ri + 1}] "${r.title}" → specificUrl=${r.specificUrl}`)
    }
    return {
      relevantRoles: withPageUrl,
      summary: typeof fb.summary === 'string' ? fb.summary : '',
    }
  }

  const shortlist = await llmShortlistTechnicalRoles(withUrl, cvText, profile, maxVisit)
  log(`  LLM: shortlist técnica ${shortlist.length} (máx ${maxVisit})`)
  for (let si = 0; si < shortlist.length; si++) {
    const row = shortlist[si]
    log(`    [shortlist ${si + 1}/${shortlist.length}] "${row.title}" → abrir: ${row.url}`)
  }

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
    const detLabel = `detalle ${i + 1}/${shortlist.length} "${String(s.title || '').slice(0, 56)}"`
    log(`    Chrome detalle [${i + 1}/${shortlist.length}]`)
    const det = await fetchCareersWithChrome(browser, s.url, detLabel, { recover404FromSite: false })
    if (!det.ok) {
      log(`    detalle falló: ${det.error || det.status}`)
      continue
    }
    const detailText =
      det.innerText && det.innerText.length > 200 ? det.innerText : htmlToText(det.html || '')
    log(
      `    [proceso] Texto para verificación LLM: ${detailText.length} chars (listado dijo url=${s.url} · Chrome finalUrl=${det.finalUrl})`,
    )
    let verdict
    const tVer = Date.now()
    try {
      verdict = await llmVerifyDetailPage({
        detailText,
        cvText,
        profile,
        listTitle: s.title,
        jobUrl: det.finalUrl || s.url,
      })
    } catch (e) {
      log(`    error verificación: ${e.message}`)
      continue
    }
    log(
      `    [LLM detalle] ${Date.now() - tVer}ms include=${verdict.include} fit=${verdict.fit || '—'} titleOut="${String(verdict.title || s.title).slice(0, 72)}"`,
    )
    if (verdict.include !== true) {
      log(`    descartado post-detalle: ${verdict.reason || verdict.redFlags || '—'}`)
      continue
    }
    log(`    [salida] Rol aceptado → specificUrl = det.finalUrl (location.href) = ${det.finalUrl}`)
    relevantRoles.push({
      title: verdict.title || s.title,
      fit: ['high', 'medium', 'low'].includes(verdict.fit) ? verdict.fit : 'medium',
      reason:
        String(verdict.reason || '').trim() +
        (s.why ? ` · Listado: ${s.why}` : '') +
        (verdict.redFlags ? ` · ${verdict.redFlags}` : ''),
      specificUrl: det.finalUrl,
      verifiedOnDetail: true,
    })
  }

  const summary =
    relevantRoles.length > 0
      ? `Se abrieron ${shortlist.length} avisos en detalle; ${relevantRoles.length} recomendables tras verificar el texto completo.`
      : 'Se revisaron avisos en detalle; ninguno cumplió criterio estricto de ingeniería para tu perfil.'
  return { relevantRoles, summary }
}

/**
 * Varias pestañas a la vez; mismo proceso Node = sin race en el contador.
 * Si `onProgress`, se llama tras cada ítem (encolado en serie para escrituras a disco).
 */
async function mapWithConcurrency(items, limit, fn, onProgress) {
  const results = new Array(items.length)
  let next = 0
  let progressTail = Promise.resolve()
  const queueProgress = () => {
    if (!onProgress) return
    progressTail = progressTail
      .then(() => onProgress(results))
      .catch((e) => {
        try {
          log(`[live-progress] ${e.message || e}`)
        } catch {
          /* noop */
        }
      })
  }
  async function worker() {
    while (true) {
      const idx = next++
      if (idx >= items.length) break
      results[idx] = await fn(items[idx], idx)
      queueProgress()
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  if (onProgress) await progressTail
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
  const fetched = await fetchCareersWithChrome(browser, url, '', { recover404FromSite: true })
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
  const publicDir = join(root, 'public')
  const genPublic = join(publicDir, 'generated')
  const liveProgressPath = join(genPublic, 'live-progress.json')

  async function writeLiveProgressSnapshot(resultsArr) {
    const completed = resultsArr.reduce((acc, r) => acc + (r !== undefined ? 1 : 0), 0)
    const companiesPartial = resultsArr.map((r) => (r === undefined ? null : r))
    const partial = {
      partial: true,
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
      scanProgress: { completed, total: companies.length },
      companies: companiesPartial,
    }
    await mkdir(genPublic, { recursive: true })
    await writeFile(liveProgressPath, JSON.stringify(partial, null, 2), 'utf8')
  }

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

    await mkdir(genPublic, { recursive: true })
    await writeLiveProgressSnapshot(Array.from({ length: companies.length }))

    results = await mapWithConcurrency(
      companies,
      concurrency,
      (c, idx) => scanOneCompany(browser, c, idx, total, cvText, useLLM),
      writeLiveProgressSnapshot,
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
    const scansDir = join(genPublic, 'scans')
    await mkdir(scansDir, { recursive: true })

    const scanFile = `scan-${generatedAt.replace(/:/g, '-')}.json`
    const relScan = `scans/${scanFile}`
    await writeFile(join(scansDir, scanFile), json, 'utf8')
    await writeFile(join(genPublic, 'latest.json'), json, 'utf8')
    try {
      await unlink(liveProgressPath)
    } catch {
      /* ya borrado o no existía */
    }

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
    try {
      await unlink(liveProgressPath)
    } catch {
      /* noop */
    }
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
