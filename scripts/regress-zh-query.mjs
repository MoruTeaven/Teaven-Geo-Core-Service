/**
 * 线上回归验证：/geo/resolve 与 /geo/search 的中文/日文查询
 *
 * 背景：生产库 location_names.name_norm 曾对 zh 98.7% / ja 99.9% 为空，
 * 导致 `WHERE name_norm = ?1` 几乎永不命中，中文日文路径解析与级联搜索
 * 全部退化到 `name LIKE '%...%'` 兜底。重新生成并导入数据后，用本脚本
 * 对线上服务做一次可复跑的回归。
 *
 * 使用方式：
 *   node scripts/regress-zh-query.mjs                        # 默认线上地址
 *   node scripts/regress-zh-query.mjs --base=http://127.0.0.1:8787
 *
 * 退出码：0 = 全部用例通过；1 = 有失败用例。
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = argOf('base', 'https://teaven-geo-core-service.moruteaven.qzz.io');

/**
 * 用例：expect 里写判定函数，避免把期望值写死成会随 GeoNames 版本变化的 ID。
 * kind=resolve 时 path 走 /geo/resolve；kind=search 时走 /geo/search。
 */
const CASES = [
  {
    name: 'resolve 中文两级路径「中国 北京」',
    kind: 'resolve',
    path: '中国 北京',
    expect: (r) => r.location_id > 0 && r.level === 'admin1',
  },
  {
    name: 'resolve 中文三级路径「中国 北京 朝阳区」',
    kind: 'resolve',
    path: '中国 北京 朝阳区',
    expect: (r) => r.location_id > 0,
  },
  {
    name: 'resolve 中文三级路径「中国 山东省 济南」',
    kind: 'resolve',
    path: '中国 山东省 济南',
    expect: (r) => r.location_id > 0,
  },
  {
    name: 'resolve 带行政后缀「中国 山东省 济南市」',
    kind: 'resolve',
    path: '中国 山东省 济南市',
    expect: (r) => r.location_id > 0,
  },
  {
    name: 'resolve 繁体「中国 華盛頓縣」→ 应能解析或明确报歧义（不再 404 找不到）',
    kind: 'resolve',
    path: '美国 華盛頓縣',
    expect: (r) => r.location_id > 0 || /Ambiguous/.test(r.error || ''),
  },
  {
    name: 'resolve 日文「日本 大阪」',
    kind: 'resolve',
    path: '日本 大阪',
    lang: 'ja',
    expect: (r) => r.location_id > 0,
  },
  {
    name: 'resolve 日文「日本 東京都」',
    kind: 'resolve',
    path: '日本 東京都',
    lang: 'ja',
    expect: (r) => r.location_id > 0,
  },
  {
    name: 'search 中文单 token「北京」命中北京市',
    kind: 'search',
    path: '北京',
    expect: (r) => (r.results || []).some((x) => x.name === '北京市'),
  },
  {
    name: 'search 中文单 token「城关」有结果',
    kind: 'search',
    path: '城关',
    expect: (r) => (r.results || []).length > 0,
  },
  {
    name: 'search 中文级联「中国 北京 朝阳」',
    kind: 'search',
    path: '中国 北京 朝阳',
    expect: (r) => (r.results || []).length > 0,
  },
  {
    name: 'search 中文级联「中国 山东省 济南」',
    kind: 'search',
    path: '中国 山东省 济南',
    expect: (r) => (r.results || []).length > 0,
  },
  {
    name: 'search 日文「日本 大阪」',
    kind: 'search',
    path: '日本 大阪',
    lang: 'ja',
    expect: (r) => (r.results || []).length > 0,
  },
  {
    name: 'search 日文单 token「大阪」',
    kind: 'search',
    path: '大阪',
    lang: 'ja',
    expect: (r) => (r.results || []).length > 0,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(kind, path, lang) {
  const url = new URL(`${BASE}/geo/${kind}`);
  url.searchParams.set('path', path);
  if (lang) url.searchParams.set('lang', lang);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      return { status: res.status, body };
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

async function main() {
  console.log(`=== 线上中文/日文查询回归 ===`);
  console.log(`  base: ${BASE}`);

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(`  health: ${JSON.stringify(health.services)}`);

  const failures = [];
  for (const c of CASES) {
    const { status, body } = await call(c.kind, c.path, c.lang);
    const ok = c.expect(body);
    const brief = c.kind === 'search'
      ? `${(body.results || []).length} 条${body.results?.[0] ? `，首条 ${body.results[0].name}(${body.results[0].level})` : ''}`
      : (body.location_id ? `id=${body.location_id} level=${body.level}${body.partial ? ' partial' : ''}` : `error=${body.error}`);
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${c.name} — HTTP ${status}, ${brief}`);
    if (!ok) failures.push(c.name);
  }

  console.log(`\n=== 结论 ===`);
  if (failures.length === 0) {
    console.log(`  全部 ${CASES.length} 个用例通过`);
    process.exit(0);
  }
  console.log(`  ${failures.length}/${CASES.length} 个用例失败:`);
  for (const f of failures) console.log(`    - ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
