/**
 * GeoNames 数据处理与 D1 SQL 生成脚本
 * 
 * 使用方式：
 *   node scripts/process-geoname.js
 * 
 * 处理流程：
 *   1. 解析 allCountries.txt → locations 表（仅 admin 级别）
 *   2. 解析 alternateNamesV2.txt → location_names（zh/en/ja）
 *   3. 解析 hierarchy.txt → 补充 parent_id 关系
 *   4. 生成 SQL 文件 → data/processed/seed.sql
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(PROJECT_ROOT, 'data', 'raw');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');

// Feature codes for administrative divisions
const ADMIN_FEATURE_CODES = new Set([
  'PCLI', 'PCLD', 'PCLIX',
  'ADM1', 'ADM2', 'ADM3', 'ADM4', 'ADM5',
  'ADM1H', 'ADM2H',
]);

const FEATURE_TO_LEVEL = {
  'PCLI': 'country', 'PCLD': 'country', 'PCLIX': 'country',
  'ADM1': 'admin1', 'ADM1H': 'admin1',
  'ADM2': 'admin2', 'ADM2H': 'admin2',
  'ADM3': 'admin3', 'ADM4': 'admin3', 'ADM5': 'admin3',
};

// 语言代码映射
const TARGET_LANGS = new Set(['zh', 'en', 'ja', 'zho', 'eng', 'jpn', 'chi']);
const LANG_MAP = { zho: 'zh', chi: 'zh', eng: 'en', jpn: 'ja' };

// 内存中的数据结构
/** @type {Map<number, {id:number, parent_id:number|null, level:string, country_code:string|null, latitude:number|null, longitude:number|null, name_en:string}>} */
const locations = new Map();
/** @type {{location_id:number, lang:string, name:string, name_norm:string}[]} */
const names = [];
/** @type {{parent_id:number, child_id:number, type:string}[]} */
const hierarchies = [];

// 行政后缀正则
const ADMIN_SUFFIX_REGEX = /(省|市|区|县|自治区|特别行政区|自治州|自治县|镇|乡|村|province|city|district|county|state|prefecture|autonomous region|special administrative region|municipality|town|township|village|ward|都|道|府|県|町|村)$/i;

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(ADMIN_SUFFIX_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapLang(isoLang) {
  if (TARGET_LANGS.has(isoLang)) {
    return LANG_MAP[isoLang] || isoLang;
  }
  return null;
}

// =============================================
// 解析 allCountries.txt
// =============================================

async function parseAllCountries(filePath) {
  console.log('  Parsing allCountries.txt ...');
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const featureCode = fields[7];

    if (!ADMIN_FEATURE_CODES.has(featureCode)) continue;

    const id = parseInt(fields[0], 10);
    const name = fields[1];
    const latitude = parseFloat(fields[4]) || null;
    const longitude = parseFloat(fields[5]) || null;
    const countryCode = fields[8] || null;
    const level = FEATURE_TO_LEVEL[featureCode] || 'admin3';

    locations.set(id, {
      id,
      parent_id: null,
      level,
      country_code: countryCode,
      latitude,
      longitude,
      name_en: name,
    });

    names.push({
      location_id: id,
      lang: 'en',
      name,
      name_norm: normalizeName(name),
    });

    count++;
    if (count % 100000 === 0) {
      console.log(`    Processed ${count} admin locations...`);
    }
  }

  console.log(`  Total admin locations: ${locations.size}`);
}

// =============================================
// 解析 alternateNamesV2.txt
// =============================================

async function parseAlternateNames(filePath) {
  console.log('  Parsing alternateNamesV2.txt ...');
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream });

  let count = 0;
  let added = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const geonameId = parseInt(fields[1], 10);
    const isoLang = fields[2];
    const alternateName = fields[3];

    const mappedLang = mapLang(isoLang);
    if (!mappedLang) continue;

    if (!locations.has(geonameId)) continue;
    if (alternateName.length > 200) continue;

    names.push({
      location_id: geonameId,
      lang: mappedLang,
      name: alternateName,
      name_norm: normalizeName(alternateName),
    });

    added++;
    count++;
    if (count % 500000 === 0) {
      console.log(`    Processed ${count} alt names, added ${added}...`);
    }
  }

  console.log(`  Total alternate names added: ${added}`);
}

// =============================================
// 解析 hierarchy.txt
// =============================================

async function parseHierarchy(filePath) {
  console.log('  Parsing hierarchy.txt ...');
  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const parentId = parseInt(fields[0], 10);
    const childId = parseInt(fields[1], 10);

    if (!locations.has(parentId) || !locations.has(childId)) continue;

    hierarchies.push({
      parent_id: parentId,
      child_id: childId,
      type: fields[2] || 'ADM',
    });

    count++;
  }

  console.log(`  Total hierarchies: ${count}`);
}

// =============================================
// 补充 parent_id
// =============================================

function buildParentRelations() {
  console.log('  Building parent relations from hierarchy...');
  let updated = 0;

  for (const h of hierarchies) {
    const child = locations.get(h.child_id);
    if (child && child.parent_id === null) {
      child.parent_id = h.parent_id;
      updated++;
    }
  }

  console.log(`  Updated ${updated} parent_id relations`);
}

// =============================================
// 去重名称
// =============================================

function deduplicateNames() {
  console.log('  Deduplicating names...');
  const seen = new Set();
  const deduped = [];

  for (const n of names) {
    const key = `${n.location_id}|${n.lang}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(n);
    }
  }

  console.log(`  Deduped: ${names.length} → ${deduped.length}`);
  // 替换数组内容（避免 push(...) 爆栈）
  names.splice(0, names.length);
  for (const item of deduped) {
    names.push(item);
  }
}

// =============================================
// 生成 SQL
// =============================================

function escapeSql(str) {
  return str.replace(/'/g, "''");
}

function generateSql() {
  console.log('  Generating SQL...');
  let sql = '-- =============================================\n';
  sql += '-- Teaven Geo Core Service - Seed Data\n';
  sql += '-- Generated by process-geoname.js\n';
  sql += `-- Locations: ${locations.size}, Names: ${names.length}\n`;
  sql += '-- =============================================\n\n';

  sql += 'PRAGMA foreign_keys = OFF;\n\n';
  sql += 'BEGIN TRANSACTION;\n\n';

  // locations
  sql += '-- locations\n';
  let locCount = 0;
  const locBatch = [];
  for (const loc of locations.values()) {
    const pid = loc.parent_id != null ? loc.parent_id : 'NULL';
    const lat = loc.latitude != null ? loc.latitude : 'NULL';
    const lng = loc.longitude != null ? loc.longitude : 'NULL';
    const cc = escapeSql(loc.country_code || '');
    locBatch.push(
      `(${loc.id},${pid},'${loc.level}','${cc}',${lat},${lng},1)`,
    );
    locCount++;

    if (locBatch.length >= 500) {
      sql += `INSERT INTO locations (id, parent_id, level, country_code, latitude, longitude, is_active) VALUES\n  ${locBatch.join(',\n  ')};\n\n`;
      locBatch.length = 0;
    }
  }
  if (locBatch.length > 0) {
    sql += `INSERT INTO locations (id, parent_id, level, country_code, latitude, longitude, is_active) VALUES\n  ${locBatch.join(',\n  ')};\n\n`;
  }
  console.log(`  Locations SQL: ${locCount} rows`);

  // location_names
  sql += '-- location_names\n';
  let nameCount = 0;
  const nameBatch = [];
  for (const n of names) {
    nameBatch.push(
      `(${n.location_id},'${n.lang}','${escapeSql(n.name)}','${escapeSql(n.name_norm)}')`,
    );
    nameCount++;

    if (nameBatch.length >= 500) {
      sql += `INSERT INTO location_names (location_id, lang, name, name_norm) VALUES\n  ${nameBatch.join(',\n  ')};\n\n`;
      nameBatch.length = 0;
    }
  }
  if (nameBatch.length > 0) {
    sql += `INSERT INTO location_names (location_id, lang, name, name_norm) VALUES\n  ${nameBatch.join(',\n  ')};\n\n`;
  }
  console.log(`  Names SQL: ${nameCount} rows`);

  sql += 'COMMIT;\n\n';
  sql += 'PRAGMA foreign_keys = ON;\n';

  return sql;
}

// =============================================
// 主流程
// =============================================

async function main() {
  console.log('=== GeoNames Data Processing ===\n');

  // Step 1: 解析 allCountries
  let allCountriesPath = path.join(RAW_DIR, 'allCountries.txt');
  if (!fs.existsSync(allCountriesPath)) {
    allCountriesPath = path.join(RAW_DIR, 'allCountries', 'allCountries.txt');
  }
  if (!fs.existsSync(allCountriesPath)) {
    console.error('ERROR: allCountries.txt not found. Run download-geoname.js first.');
    console.error(`Tried: ${path.join(RAW_DIR, 'allCountries.txt')}`);
    console.error(`Tried: ${path.join(RAW_DIR, 'allCountries', 'allCountries.txt')}`);
    process.exit(1);
  }
  await parseAllCountries(allCountriesPath);

  // Step 2: 解析 alternateNamesV2
  let altNamesPath = path.join(RAW_DIR, 'alternateNamesV2.txt');
  if (!fs.existsSync(altNamesPath)) {
    altNamesPath = path.join(RAW_DIR, 'alternateNamesV2', 'alternateNamesV2.txt');
  }
  if (fs.existsSync(altNamesPath)) {
    await parseAlternateNames(altNamesPath);
  } else {
    console.warn('WARNING: alternateNamesV2 not found, only English names will be available');
  }

  // Step 3: 解析 hierarchy
  let hierarchyPath = path.join(RAW_DIR, 'hierarchy.txt');
  if (!fs.existsSync(hierarchyPath)) {
    hierarchyPath = path.join(RAW_DIR, 'hierarchy', 'hierarchy.txt');
  }
  if (fs.existsSync(hierarchyPath)) {
    await parseHierarchy(hierarchyPath);
    buildParentRelations();
  } else {
    console.warn('WARNING: hierarchy.txt not found, parent_id will be null');
  }

  // Step 4: 去重
  deduplicateNames();

  // Step 5: 生成 SQL
  const sql = generateSql();

  // Step 6: 写入文件
  if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
  }
  const sqlPath = path.join(PROCESSED_DIR, 'seed.sql');
  fs.writeFileSync(sqlPath, sql, 'utf-8');
  const stats = fs.statSync(sqlPath);
  console.log(`\n  SQL written to: ${sqlPath}`);
  console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);

  // Step 7: 统计信息
  console.log('\n=== Processing Summary ===');
  console.log(`  Locations:       ${locations.size}`);
  console.log(`  Names:           ${names.length}`);
  console.log(`  Hierarchies:     ${hierarchies.length}`);

  const byLevel = {};
  for (const loc of locations.values()) {
    byLevel[loc.level] = (byLevel[loc.level] || 0) + 1;
  }
  for (const [level, count] of Object.entries(byLevel)) {
    console.log(`    ${level}: ${count}`);
  }

  const byLang = {};
  for (const n of names) {
    byLang[n.lang] = (byLang[n.lang] || 0) + 1;
  }
  for (const [lang, count] of Object.entries(byLang)) {
    console.log(`    lang ${lang}: ${count}`);
  }

  console.log('\n=== Done ===');
  console.log(`Import command: wrangler d1 execute teaven-geo-db --file=data/processed/seed.sql`);
}

main().catch(console.error);
