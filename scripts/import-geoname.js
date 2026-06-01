/**
 * GeoNames 数据一键导入脚本
 * 
 * 使用方式：
 *   # 本地 D1
 *   node scripts/import-geoname.js --local
 * 
 *   # 远程 D1
 *   node scripts/import-geoname.js --remote
 * 
 * 流程：
 *   1. 下载原始数据 (download-geoname.js)
 *   2. 处理数据生成 SQL (process-geoname.js)
 *   3. 执行 SQL 导入 D1
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runStep(name: string, cmd: string): Promise<void> {
  console.log(`\n[${name}]`);
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
  } catch (e: any) {
    console.error(`  [ERROR] ${name} failed: ${e.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isRemote = args.includes('--remote');
  const isLocal = args.includes('--local');

  if (!isRemote && !isLocal) {
    console.log('Usage:');
    console.log('  node scripts/import-geoname.js --local   (import to local D1)');
    console.log('  node scripts/import-geoname.js --remote  (import to remote D1)');
    process.exit(1);
  }

  console.log('=== GeoNames Full Import ===');
  console.log(`Target: ${isLocal ? 'Local D1' : 'Remote D1'}`);

  // Step 1: 下载
  await runStep('Step 1: Download', 'node scripts/download-geoname.js');

  // Step 2: 处理
  await runStep('Step 2: Process', 'node scripts/process-geoname.js');

  // Step 3: 初始化 Schema
  const localFlag = isLocal ? ' --local' : '';
  await runStep(
    'Step 3: Init Schema',
    `npx wrangler d1 execute teaven-geo-db${localFlag} --file=db/migrations/001_init.sql`,
  );

  // Step 4: 导入种子数据
  await runStep(
    'Step 4: Import Seed Data',
    `npx wrangler d1 execute teaven-geo-db${localFlag} --file=data/processed/seed.sql`,
  );

  console.log('\n=== Import Complete ===');
  console.log(`Run "npm run dev" to start the Worker locally.`);
}

main().catch(console.error);
