#!/usr/bin/env node
/**
 * Open Food Facts → Spain-filtered nutrition corpus.
 *
 * Sibling to build.mjs. Ingests branded Spanish products (with real barcodes)
 * from the Open Food Facts CSV export, streaming and filtering on the fly —
 * the full export is ~9-12 GB uncompressed, so it is never written to disk in
 * full. Only rows whose countries_tags includes `en:spain` are kept.
 *
 * Writes to the SAME schema as build.mjs (packages/db-adapter/src/schema.ts),
 * so nothing downstream (resolver, FTS5, UI) needs to change. Rows are tagged
 * source='off_es' / license='ODbL-1.0' so they can always be told apart from
 * the USDA generic tier.
 */

import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { mkdir, readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../..')
const OUT = process.env.OUT ?? join(REPO, 'apps/mobile/assets/nutrition.db')
const SOURCE_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'

const REQUIRED_COLUMNS = [
  'code', 'product_name', 'brands', 'stores', 'categories_tags', 'countries_tags',
  'serving_size', 'energy-kcal_100g', 'proteins_100g', 'fat_100g',
  'saturated-fat_100g', 'carbohydrates_100g', 'fiber_100g', 'sugars_100g',
  'sodium_100g',
]

/**
 * Chains with strong or Andalucía-specific presence, used only to bias
 * `popularity_rank` — never to exclude products from other chains. Covirán is
 * HQ'd in Granada and disproportionately present in Andalucía versus the rest
 * of Spain; the others are nationwide chains with heavy Andalucía coverage.
 * This is a proxy, not a real regional filter — Open Food Facts has no
 * region-level tag, only country.
 */
const ANDALUCIA_BOOST_CHAINS = [
  'coviran', 'mercadona', 'carrefour', 'dia', 'lidl', 'eroski',
  'consum', 'aldi', 'alcampo', 'supersol', 'spar',
]

function matchesAndaluciaChain(storesText, brandText) {
  const haystack = `${storesText} ${brandText}`.toLowerCase()
  return ANDALUCIA_BOOST_CHAINS.some((chain) => haystack.includes(chain))
}

function num(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function gramsFromServingSize(s) {
  if (!s) return null
  const m = /^\s*([\d.,]+)\s*g\b/i.exec(s)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

async function main() {
  console.log('nutai-nutrition-data — building the OFF Spain tier\n')
  console.log(`Streaming ${SOURCE_URL}`)

  const res = await fetch(SOURCE_URL)
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)

  const rl = createInterface({
    input: Readable.fromWeb(res.body).pipe(createGunzip()),
    crlfDelay: Infinity,
  })

  let colIndex = null
  let rowNum = 0
  const keptRows = []

  for await (const line of rl) {
    rowNum++
    const cells = line.split('\t')

    if (!colIndex) {
      const header = cells
      colIndex = {}
      header.forEach((h, i) => { colIndex[h.trim()] = i })
      const missing = REQUIRED_COLUMNS.filter((col) => !(col in colIndex))
      if (missing.length > 0) {
        throw new Error(
          `HEADER MISMATCH in Open Food Facts export\n` +
            `  MISSING: ${missing.join(', ')}\n\n` +
            `  Open Food Facts changed its export shape. Do NOT paper over it —` +
            ` confirm the new column names before updating REQUIRED_COLUMNS.`,
        )
      }
      continue
    }

    const countries = cells[colIndex['countries_tags']] ?? ''
    if (!countries.split(',').map((t) => t.trim()).includes('en:spain')) continue

    const c = (name) => cells[colIndex[name]] ?? ''
    const barcode = c('code').trim()
    const name = c('product_name').trim()
    const kcal = num(c('energy-kcal_100g'))
    if (!barcode || !name || kcal == null) continue

    const boosted = matchesAndaluciaChain(c('stores'), c('brands'))
    keptRows.push({ cells, boosted })

    if (rowNum % 200_000 === 0) {
      console.log(`  scanned ${rowNum.toLocaleString()} rows, kept ${keptRows.length.toLocaleString()}`)
    }
  }

  console.log(`\nScanned ${rowNum.toLocaleString()} rows total, ${keptRows.length.toLocaleString()} are Spanish products`)

  // Andalucía-relevant chains first -> lower popularity_rank -> the resolver's
  // tie-break prefers them. Stable sort keeps export order within each group.
  keptRows.sort((a, b) => Number(b.boosted) - Number(a.boosted))

  await mkdir(dirname(OUT), { recursive: true })
  const db = new Database(OUT)
  db.pragma('journal_mode = DELETE')
  db.exec('DROP TABLE IF EXISTS foods; DROP TABLE IF EXISTS food_portions; DROP TABLE IF EXISTS food_fts; DROP TABLE IF EXISTS food_fts_trigram; DROP TABLE IF EXISTS build_manifest; DROP TABLE IF EXISTS brands; DROP TABLE IF EXISTS food_micros; DROP TABLE IF EXISTS food_synonyms;')

  const schemaSrc = await readFile(join(REPO, 'packages/db-adapter/src/schema.ts'), 'utf8')
  const grab = (name) => {
    const m = new RegExp(`export const ${name} = \`([\\s\\S]*?)\``).exec(schemaSrc)
    if (!m) throw new Error(`could not extract ${name} from schema.ts`)
    return m[1]
  }
  db.exec(grab('NUTRITION_SCHEMA'))
  db.exec(grab('NUTRITION_FTS_SCHEMA'))

  const insertBrand = db.prepare('INSERT INTO brands (canonical_name) VALUES (?)')
  const brandIds = new Map()

  const insertFood = db.prepare(`
    INSERT INTO foods (id, source, source_id, name, brand_id, category, basis,
                       basis_confidence, serving_size_g, barcode,
                       energy_kcal, protein_g, fat_g, sat_fat_g, carb_g, fiber_g,
                       sugar_g, sodium_mg, completeness_score, popularity_rank,
                       license, updated_at)
    VALUES (?, 'off_es', ?, ?, ?, ?, 'per_100g', 'medium', ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ODbL-1.0', ?)
  `)
  const insertFts = db.prepare('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)')
  const insertTri = db.prepare('INSERT INTO food_fts_trigram (rowid, name) VALUES (?,?)')
  const insertPortion = db.prepare(`
    INSERT INTO food_portions (food_id, measure_unit, modifier, amount, gram_weight, is_fndds_default)
    VALUES (?,?,?,?,?,1)
  `)

  const now = Date.now()
  let kept = 0

  const insertOne = db.transaction((cells, rank) => {
    const c = (name) => cells[colIndex[name]] ?? ''
    const barcode = c('code').trim()
    const name = c('product_name').trim()
    const kcal = num(c('energy-kcal_100g'))

    const brandRaw = c('brands').split(',')[0]?.trim() || null
    let brandId = null
    if (brandRaw) {
      if (!brandIds.has(brandRaw)) {
        const info = insertBrand.run(brandRaw)
        brandIds.set(brandRaw, info.lastInsertRowid)
      }
      brandId = brandIds.get(brandRaw)
    }

    const servingG = gramsFromServingSize(c('serving_size'))
    const sodiumG = num(c('sodium_100g'))

    insertFood.run(
      rank, barcode, name, brandId, c('categories_tags').split(',')[0] || null,
      servingG, barcode,
      kcal, num(c('proteins_100g')), num(c('fat_100g')), num(c('saturated-fat_100g')),
      num(c('carbohydrates_100g')), num(c('fiber_100g')), num(c('sugars_100g')),
      sodiumG != null ? sodiumG * 1000 : null,
      0.5, rank, now,
    )
    insertFts.run(rank, name, brandRaw ?? '', '')
    insertTri.run(rank, name)
    if (servingG != null) insertPortion.run(rank, 'serving', null, 1, servingG)
  })

  for (const { cells } of keptRows) {
    kept++
    insertOne(cells, kept)
  }

  const manifest = db.prepare('INSERT OR REPLACE INTO build_manifest (key, value) VALUES (?,?)')
  db.transaction(() => {
    manifest.run('tier', 'off_es')
    manifest.run('sources', 'Open Food Facts (Spain-filtered, Andalucía chain boost)')
    manifest.run('licenses', 'ODbL-1.0 (Open Food Facts)')
    manifest.run('attribution', 'Open Food Facts contributors, https://es.openfoodfacts.org')
    manifest.run('food_count', String(kept))
    manifest.run('schema_version', '1')
    manifest.run('built_at', new Date(now).toISOString())
  })()

  db.exec('VACUUM')
  db.close()

  console.log(`\nBuilt ${OUT}`)
  console.log(`  scanned: ${rowNum.toLocaleString()} rows`)
  console.log(`  kept:    ${kept.toLocaleString()} Spanish products`)
}

main().catch((err) => {
  console.error('\nBUILD FAILED\n')
  console.error(err.message)
  process.exit(1)
})
