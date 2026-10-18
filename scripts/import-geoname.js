/**
 * GeoNames 数据一键导入脚本
 *
 * 使用方式：
 *   # 本地 D1
 *   node scripts/import-geoname.js --local
 *
 *   # 远程 D1（生产）
 *   node scripts/import-geoname.js --remote
 *
 * 流程：
 *   1. 下载原始数据 (download-geoname.js)
 *   2. 处理数据生成 SQL (process-geoname.js)
 *   3. 本地校验 seed.sql (verify-seed.mjs)：空 name_norm 必须为 0
 *   4a. 本地：wrangler d1 execute --local 导入
 *   4b. 远程：import-d1-remote.mjs 影子表分批导入 + 校验 + 原子切换
 *
 * 注意：远程导入不能用 `wrangler d1 execute --file`——50 MB 级别的 SQL 会让
 * wrangler 在 workerd 层崩溃，且中途失败无法续传；远程一律走 import-d1-remote.mjs。
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 执行一个流水线步骤
 * @param {string} name 步骤名
 * @param {string} cmd 命令
 */
async function runStep(name, cmd) {
  console.log(`\n[${name}]`);
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
  } catch (e) {
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

  // Step 3: 本地校验 —— 空 name_norm 必须为 0，否则导进去也是坏的
  await runStep('Step 3: Verify Seed', 'node scripts/verify-seed.mjs');

  if (isLocal) {
    // Step 4a: 本地 Schema + 数据
    await runStep(
      'Step 4: Init Schema (local)',
      'npx wrangler d1 execute teaven-geo-db --local --file=db/migrations/001_init.sql',
    );
    await runStep(
      'Step 5: Import Seed Data (local)',
      'npx wrangler d1 execute teaven-geo-db --local --file=data/processed/seed.sql',
    );
  } else {
    // Step 4b: 远程影子表导入（分批、可续传、原子切换）
    console.log('\n[Step 4: Prepare Shadow Tables (remote)]');
    console.log('  需要环境变量 CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DATABASE_ID');
    await runStep('Step 4: Prepare (remote)', 'node scripts/import-d1-remote.mjs --prepare');
    await runStep('Step 5: Load (remote)', 'node scripts/import-d1-remote.mjs --load');
    await runStep('Step 6: Verify (remote)', 'node scripts/import-d1-remote.mjs --verify');
    await runStep('Step 7: Swap (remote)', 'node scripts/import-d1-remote.mjs --swap');
    await runStep('Step 8: Regress zh/ja queries', 'node scripts/regress-zh-query.mjs');
  }

  console.log('\n=== Import Complete ===');
  console.log(`Run "npm run dev" to start the Worker locally.`);
}

main().catch(console.error);
