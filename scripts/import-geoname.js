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
 * ⚠️ 通过 npm 调用时，参数必须写在 `--` 之后，否则会被 npm 自己吃掉、脚本收不到：
 *   npm run db:seed -- --local     # 正确
 *   npm run db:seed --local        # 错误：脚本只看到 Usage
 * 也可以在 package.json 里写死，把 db:seed 拆成 db:seed:local / db:seed:remote。
 *
 * 流程：
 *   1. 下载原始数据 (download-geoname.js)
 *   2. 处理数据生成 SQL (process-geoname.js)
 *   3. 初始化 Schema (db/migrations/001_init.sql)
 *   4. 导入种子数据（本地走 import-direct.js，远程走 wrangler d1 execute）
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * 执行一个子步骤，失败即中止整个流程
 * @param {string} name 步骤名（用于日志）
 * @param {string} cmd 要执行的 shell 命令
 */
async function runStep(name, cmd) {
  console.log(`\n[${name}]`);
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
    });
  } catch (e) {
    console.error(`  [ERROR] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
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
    console.log('');
    console.log('Via npm (the -- is required, otherwise npm eats the flag):');
    console.log('  npm run db:seed -- --local');
    process.exit(1);
  }

  console.log('=== GeoNames Full Import ===');
  console.log(`Target: ${isLocal ? 'Local D1' : 'Remote D1'}`);

  // Step 1: 下载
  await runStep('Step 1: Download', `node "${path.join('scripts', 'download-geoname.js')}"`);

  // Step 2: 处理
  await runStep('Step 2: Process', `node "${path.join('scripts', 'process-geoname.js')}"`);

  // Step 3: 初始化 Schema。
  // 实测：001_init.sql 全部使用 CREATE TABLE/INDEX/VIEW IF NOT EXISTS，连续执行两次
  // 均返回 success:true，因此这一步本身是幂等的，重复导入不会中止。
  // 注意：本地路径下这一步是冗余的——Step 4 的 import-direct.js 会自己建表；
  //       但对「表结构变更后想单独刷 schema」仍有独立价值，故保留。
  const localFlag = isLocal ? ' --local' : '';
  await runStep(
    'Step 3: Init Schema',
    `npx wrangler d1 execute teaven-geo-db${localFlag} --file=db/migrations/001_init.sql`,
  );

  // Step 4: 导入种子数据
  // 实测：100 万行 / 50MB 的 seed.sql 走 `wrangler d1 execute --file` 会崩在
  // workerd 内部（kj/table.c++ HashIndex inconsistency + Body Timeout Error），
  // 本地导入统一改用 import-direct.js（sql.js 直写 D1 文件；同样数据量 0 错误跑完）。
  if (isLocal) {
    await runStep(
      'Step 4: Import Seed Data (direct sql.js)',
      `node "${path.join('scripts', 'import-direct.js')}"`,
    );
  } else {
    await runStep(
      'Step 4: Import Seed Data',
      `npx wrangler d1 execute teaven-geo-db --file=data/processed/seed.sql`,
    );
  }

  console.log('\n=== Import Complete ===');
  console.log(`Run "npm run dev" to start the Worker locally.`);
}

main().catch(console.error);
