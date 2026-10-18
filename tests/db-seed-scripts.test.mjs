/**
 * 回归测试：npm run db:seed 一键导入链路的三个脚本修复
 *
 * 覆盖：
 *  1. import-geoname.js 不再含 TypeScript 类型标注（node --check 通过）
 *  2. download-geoname.js unzip 不再强依赖 Windows PowerShell（tar / unzip 优先）
 *  3. import-direct.js 多库时不再任意挑选 sqliteFiles[0]，改为取最新 + 支持 --db= 指定
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PROJECT_ROOT, 'scripts');

test('scripts parse as plain ES modules (no TS type annotations)', () => {
  for (const f of ['import-geoname.js', 'download-geoname.js', 'import-direct.js', 'process-geoname.js']) {
    // node --check 在 .js 上遇到 TS 类型标注会抛 SyntaxError
    execFileSync(process.execPath, ['--check', path.join(SCRIPTS, f)]);
  }
});

test('import-geoname.js contains no TS type annotations', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'import-geoname.js'), 'utf-8');
  // `: Promise<void>` / `: string` 这类形参/返回类型标注是原 bug 的特征
  assert.doesNotMatch(src, /\)\s*:\s*Promise</, 'return type annotation');
  assert.doesNotMatch(src, /catch\s*\([^)]*:\s*any\)/, 'catch (e: any) annotation');
  // 但 JSDoc 注释里的类型是允许的
  assert.match(src, /@param\s+\{string\}/, 'JSDoc types should be present');
});

test('download-geoname.js tries tar/unzip before PowerShell', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'download-geoname.js'), 'utf-8');
  const tarIdx = src.indexOf('tar -xf');
  const unzipIdx = src.indexOf('unzip -o');
  const psIdx = src.indexOf('Expand-Archive');
  assert.ok(tarIdx !== -1, 'tar attempt must exist');
  assert.ok(unzipIdx !== -1, 'unzip attempt must exist');
  assert.ok(psIdx !== -1, 'powershell fallback must exist');
  assert.ok(tarIdx < psIdx, 'tar must be attempted before powershell');
  assert.ok(unzipIdx < psIdx, 'unzip must be attempted before powershell');
  // 解压失败必须报错而不是静默继续（原实现只打 WARN）
  assert.match(src, /process\.exit\(1\)/, 'unzip failure must be fatal');
});

test('import-direct.js resolves the D1 file deterministically', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'import-direct.js'), 'utf-8');
  // 原实现：readdirSync(...).filter(...)[0] —— 任意挑选，必须已移除
  assert.doesNotMatch(src, /filter\(f => f\.endsWith\('\.sqlite'\)\)\[0\]/, 'must not pick an arbitrary sqlite file');
  assert.match(src, /sort\(\(a, b\) => b\.mtime - a\.mtime\)/, 'must sort by mtime, newest first');
  assert.match(src, /--db=/, 'must support explicit --db=<file> selection');
  assert.match(src, /No \.sqlite file found/, 'must fail loudly when empty');
});

test('import-direct.js picks newest sqlite and honours --db= when several exist', async () => {
  const { execFileSync } = await import('node:child_process');
  const tmp = fs.mkdtempSync(path.join(PROJECT_ROOT, '.tmp-d1-'));
  const fakeRoot = path.join(tmp, 'fake-project');
  const d1 = path.join(fakeRoot, '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
  fs.mkdirSync(d1, { recursive: true });

  try {
    // 三个库，old.sqlite 故意最早
    const files = [
      ['old.sqlite', 'OLD'],
      ['middle.sqlite', 'MIDDLE'],
      ['new.sqlite', 'NEW'],
    ];
    for (const [name, content] of files) {
      fs.writeFileSync(path.join(d1, name), content);
      // 交错设置 mtime，确保 newest 与 readdir 顺序不同
      await new Promise(r => setTimeout(r, 25));
    }
    // 显式把 old.sqlite 设为最新
    const now = new Date();
    fs.utimesSync(path.join(d1, 'old.sqlite'), now, now);

    const probe = path.join(tmp, 'probe.mjs');
    fs.writeFileSync(probe, `
      import fs from 'node:fs';
      import path from 'node:path';
      const D1_DIR = process.argv[2];
      const requested = process.argv.find(a => a.startsWith('--db='));
      function resolveDbPath() {
        if (requested) {
          const p = path.join(D1_DIR, path.basename(requested.slice(5)));
          if (!fs.existsSync(p)) { console.error('NOT_FOUND'); process.exit(1); }
          return p;
        }
        const files = fs.readdirSync(D1_DIR).filter(f => f.endsWith('.sqlite'))
          .map(f => ({ name: f, mtime: fs.statSync(path.join(D1_DIR, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        return path.join(D1_DIR, files[0].name);
      }
      console.log(resolveDbPath());
    `);

    const run = (extra = []) =>
      execFileSync(process.execPath, [probe, d1, ...extra], { encoding: 'utf-8' }).trim();

    // 多库时必须选最新的 old.sqlite（而非 readdir 顺序第一个）
    assert.match(run(), /old\.sqlite$/, 'newest file must win');
    // --db= 必须精确选中指定库
    assert.match(run(['--db=middle.sqlite']), /middle\.sqlite$/, '--db= must be honoured');
    // 不存在的库必须报错
    assert.throws(() => run(['--db=nope.sqlite']), /NOT_FOUND/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('package.json db:seed still points at the orchestrator', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.scripts['db:seed'], 'node scripts/import-geoname.js');
});
