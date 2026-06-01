/**
 * 从零创建本地 D1 数据库：Schema + Seed 一次性导入
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const D1_DIR = path.join(PROJECT_ROOT, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const sqliteFiles = fs.readdirSync(D1_DIR).filter(f => f.endsWith('.sqlite'));
const DB_PATH = path.join(D1_DIR, sqliteFiles[0]);

const SCHEMA_FILE = path.join(PROJECT_ROOT, 'db', 'migrations', '001_init.sql');
const SEED_FILE = path.join(PROJECT_ROOT, 'data', 'processed', 'seed.sql');

function parseStatements(sql) {
  const statements = [];
  const lines = sql.split('\n');
  let current = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    // 跳过 PRAGMA 和顶层事务命令
    if (/^(PRAGMA|BEGIN TRANSACTION|COMMIT);?$/i.test(trimmed)) continue;

    current += line + '\n';
    if (trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt.length > 0) statements.push(stmt);
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function main() {
  console.log('Loading SQL.js...');
  const SQL = await initSqlJs();

  // 创建空数据库
  console.log('Creating fresh database...');
  const db = new SQL.Database();

  // Step 1: 执行 Schema
  console.log('Step 1: Creating tables...');
  const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf-8');
  const schemaStmts = parseStatements(schemaSql);
  console.log(`  Schema statements: ${schemaStmts.length}`);
  
  try {
    db.run('BEGIN TRANSACTION;');
    for (const stmt of schemaStmts) {
      db.run(stmt);
    }
    db.run('COMMIT;');
    console.log('  Tables created successfully.');
  } catch (e) {
    db.run('ROLLBACK;');
    console.error('Schema error:', e.message);
    process.exit(1);
  }

  // 验证表
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
  console.log('  Tables:', tables[0]?.values.map(r => r[0]).join(', ') || 'none');

  // Step 2: 执行 Seed 数据
  console.log('Step 2: Importing seed data...');
  const seedSql = fs.readFileSync(SEED_FILE, 'utf-8');
  const seedStmts = parseStatements(seedSql);
  console.log(`  Seed statements: ${seedStmts.length}`);

  const BATCH_SIZE = 500;
  let executed = 0;
  let errors = 0;

  for (let i = 0; i < seedStmts.length; i += BATCH_SIZE) {
    const batch = seedStmts.slice(i, i + BATCH_SIZE);
    
    try {
      db.run('BEGIN TRANSACTION;');
      for (const stmt of batch) {
        db.run(stmt);
      }
      db.run('COMMIT;');
      executed += batch.length;
    } catch (e) {
      db.run('ROLLBACK;');
      errors++;
      if (errors <= 3) {
        console.error(`  Batch ${Math.floor(i / BATCH_SIZE)} error: ${e.message.substring(0, 100)}`);
      }
      // 逐条执行以跳过坏数据
      for (const stmt of batch) {
        try {
          db.run(stmt);
          executed++;
        } catch (e2) {
          // skip
        }
      }
    }

    if (Math.floor(i / BATCH_SIZE) % 200 === 0) {
      const pct = Math.round(executed / seedStmts.length * 100);
      console.log(`  Progress: ${executed}/${seedStmts.length} (${pct}%)`);
    }
  }

  console.log(`  Executed: ${executed}, Errors: ${errors}`);

  // 验证数据
  const locCount = db.exec('SELECT COUNT(*) FROM locations;');
  const nameCount = db.exec('SELECT COUNT(*) FROM location_names;');
  console.log(`  locations: ${locCount[0]?.values[0][0] || 0}`);
  console.log(`  location_names: ${nameCount[0]?.values[0][0] || 0}`);

  // 保存
  console.log('Saving database...');
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  console.log(`Done! DB: ${DB_PATH} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  db.close();
}

main().catch(console.error);
