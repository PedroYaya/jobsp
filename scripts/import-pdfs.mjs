#!/usr/bin/env node
/**
 * Lee todos los .pdf en /pdfs, identifica CV vs listado por nombre de archivo,
 * escribe JSON en config/generated/ y actualiza config/cv.txt + config/companies.json.
 */
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = join(__dirname, '..')
const pdfsDir = join(root, 'pdfs')
const genDir = join(root, 'config', 'generated')

function log(...a) {
  console.log('[import-pdfs]', ...a)
}

async function pdfText(buffer) {
  const data = await pdfParse(buffer)
  return { text: String(data.text || '').replace(/\r\n/g, '\n'), pages: data.numpages }
}

/** Typos frecuentes en PDFs: https// */
function fixTypos(s) {
  return String(s)
    .replace(/https\/\//gi, 'https://')
    .replace(/http\/\//gi, 'http://')
    .replace(/([a-z0-9])(https?:\/\/)/gi, '$1/$2')
}

function trimTrailingCategoryPath(href) {
  let h = href.replace(/\/$/, '')
  for (let i = 0; i < 8; i++) {
    const m = h.match(/(\/[A-Z][a-z]{2,40})$/)
    if (!m) break
    h = h.slice(0, -m[1].length)
  }
  return h || href
}

/** PDF a veces pega categoría al path: /careersSoftware, /jobsIT */
function normalizeCareersPathJunk(href) {
  try {
    const u = new URL(href)
    let p = u.pathname
    p = p
      .replace(/\/(careers)([A-Z][a-z]+)$/i, '/$1')
      .replace(/\/(jobs)([A-Z][a-z]+)$/i, '/$1')
      .replace(/\/(join-us)([A-Z][a-z]+)$/i, '/$1')
      .replace(/\/(company)\/(careers)([A-Z][a-z]+)$/i, '/$1/$2')
    u.pathname = p
    return u.href.replace(/\/$/, '')
  } catch {
    return href
  }
}

/** Una cadena tipo "https://a.com/https://a.com/careersFoo" → URLs sueltas. */
function trimToValidUrl(piece) {
  let p = piece.trim().replace(/\)+$/, '').replace(/[.,;:!?]+$/, '')
  for (let len = p.length; len > 12; len--) {
    const cand = p.slice(0, len)
    try {
      const u = new URL(cand)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      if ((u.pathname || '').includes('://')) continue
      let href = u.href.replace(/\/$/, '')
      href = trimTrailingCategoryPath(href)
      href = normalizeCareersPathJunk(href)
      return href
    } catch {
      /* continue */
    }
  }
  return null
}

function explodeUrlsFromChain(s) {
  const t = fixTypos(s)
  const indices = []
  const re = /https?:\/\//gi
  let m
  while ((m = re.exec(t)) !== null) indices.push(m.index)
  if (!indices.length) return []
  const out = []
  for (let i = 0; i < indices.length; i++) {
    const from = indices[i]
    const to = i + 1 < indices.length ? indices[i + 1] : t.length
    const slice = t.slice(from, to)
    const ok = trimToValidUrl(slice)
    if (ok) out.push(ok)
  }
  return out
}

function isPlausibleUrl(u) {
  try {
    const x = new URL(u)
    if (x.hostname.includes('https')) return false
    if ((x.pathname || '').includes('://')) return false
    if (x.hostname.length < 4) return false
    return true
  } catch {
    return false
  }
}

/** Extrae URLs del texto del PDF (incluye cadenas pegadas). */
function extractAllUrlsFromText(text) {
  const t = fixTypos(text)
  const chunks = t.match(/https?:\/\/[^\s\n]+/gi) || []
  const all = []
  const seen = new Set()
  for (const ch of chunks) {
    for (const u of explodeUrlsFromChain(ch)) {
      if (!isPlausibleUrl(u)) continue
      if (seen.has(u)) continue
      seen.add(u)
      all.push(u)
    }
  }
  return all
}

function careerScore(urlStr) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    return 0
  }
  const h = u.hostname.replace(/^www\./, '').toLowerCase()
  const p = u.pathname.toLowerCase()
  const full = (u.hostname + u.pathname).toLowerCase()

  let s = 1
  if (p.includes('career') || full.includes('career')) s += 40
  if (p.includes('/jobs') || p.includes('/job') || p.includes('job-board') || p.includes('positions')) s += 35
  if (p.includes('hiring') || p.includes('join') || p.includes('team') || p.includes('work-with')) s += 15
  if (h.includes('greenhouse') || h.includes('lever.co') || h.includes('ashby') || h.includes('workable')) s += 25
  if (h.includes('linkedin.com') || h.includes('facebook.com') || h.includes('twitter.') || h.includes('x.com'))
    s -= 50
  if (h.includes('google.') || h.includes('goo.gl')) s -= 30
  if (h.includes('crunchbase.com') && p.length < 8) s -= 20
  return s
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'empresa'
}

/** Una URL por host: la de mayor score tipo careers. */
function urlsToCompanies(urls) {
  const byHost = new Map()
  for (const url of urls) {
    let host
    try {
      host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      continue
    }
    const sc = careerScore(url)
    const prev = byHost.get(host)
    if (!prev || sc > prev.sc) byHost.set(host, { url, sc })
  }
  return [...byHost.entries()].map(([host, { url }]) => ({
    id: slug(host),
    name: host,
    careersUrl: url,
  }))
}

function pickCvPdf(files) {
  const lower = files.map((f) => ({ f, l: f.toLowerCase() }))
  const resume = lower.find(({ l }) => l.includes('resume') || l.includes('cv'))
  if (resume) return resume.f
  return null
}

function pickListPdf(files) {
  const lower = files.map((f) => ({ f, l: f.toLowerCase() }))
  const lab = lower.find(({ l }) => l.includes('laburos') || l.includes('remot'))
  if (lab) return lab.f
  const cv = pickCvPdf(files)
  if (files.length === 2 && cv) return files.find((f) => f !== cv) || files[0]
  return files[0]
}

async function main() {
  await mkdir(genDir, { recursive: true })
  const all = await readdir(pdfsDir)
  const pdfs = all.filter((f) => f.toLowerCase().endsWith('.pdf'))
  if (!pdfs.length) {
    log(`No hay .pdf en ${pdfsDir}`)
    process.exit(1)
  }
  log(`PDFs: ${pdfs.join(', ')}`)

  const cvName = pickCvPdf(pdfs)
  const listName = pickListPdf(pdfs)
  log(`CV detectado: ${cvName || '(ninguno)'}`)
  log(`Listado detectado: ${listName || '(ninguno)'}`)

  const generatedAt = new Date().toISOString()

  if (cvName) {
    const buf = await readFile(join(pdfsDir, cvName))
    const { text, pages } = await pdfText(buf)
    const cvPlain = text.trim()
    const cvMeta = {
      sourceFile: cvName,
      generatedAt,
      pages,
      characterCount: cvPlain.length,
      plainText: cvPlain,
    }
    await writeFile(join(genDir, 'cv-from-pdf.json'), JSON.stringify(cvMeta, null, 2), 'utf8')
    await writeFile(join(root, 'config', 'cv.txt'), cvPlain + (cvPlain.endsWith('\n') ? '' : '\n'), 'utf8')
    log(`CV → config/generated/cv-from-pdf.json + config/cv.txt (${cvPlain.length} chars)`)
  } else {
    log('No se encontró PDF de CV por nombre; no toco cv.txt')
  }

  if (listName) {
    const buf = await readFile(join(pdfsDir, listName))
    const { text, pages } = await pdfText(buf)
    const merged = extractAllUrlsFromText(text)
    const companies = urlsToCompanies(merged)
    const listMeta = {
      sourceFile: listName,
      generatedAt,
      pages,
      urlsFound: merged,
      companies,
    }
    await writeFile(join(genDir, 'companies-from-pdf.json'), JSON.stringify(listMeta, null, 2), 'utf8')
    await writeFile(join(root, 'config', 'companies.json'), JSON.stringify(companies, null, 2), 'utf8')
    log(
      `Listado → config/generated/companies-from-pdf.json + config/companies.json (${companies.length} empresas, ${merged.length} URLs únicas)`,
    )
  } else {
    log('No se encontró PDF de listado')
  }

  log('Listo.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
