/**
 * 简繁转换回归测试
 *
 * 背景（BUG·已验证）：原手写 ~2500 组单字映射表无法处理一对多转换，
 * 真实台港澳地名错误率 10/21（板橋→闆橋、松山→鬆山、斗六→鬥六、
 * 后里→後裡、皇后大道→皇後大道……）。现改用 opencc-js 词组级转换，
 * 本测试用真实台港澳地名锁定行为，防止回退到手写单字表类实现。
 *
 * 运行：npm test（先 build:test 打包，再 node --test）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toTraditional, isTraditionalChinese } = require('../dist/test-build/s2t.cjs');

// =============================================
// 一、bug 报告中的 10 个错误地名（历史 BUG 回归，一处都不能再错）
// =============================================

test('台湾真实地名转换（bug 报告 10 例回归）', () => {
  // [简体输入, 期望繁体, 所在地]
  const cases = [
    ['板桥区', '板橋區', '新北市'],   // 曾错：闆橋區（板→闆）
    ['永和区', '永和區', '新北市'],   // 曾错：永龢區（和→龢）
    ['中和区', '中和區', '新北市'],   // 曾错：中龢區（和→龢）
    ['斗六市', '斗六市', '雲林縣'],   // 曾错：鬥六市（斗→鬥）
    ['斗南镇', '斗南鎮', '雲林縣'],   // 曾错：鬥南鎮（斗→鬥）
    ['后里区', '后里區', '台中市'],   // 曾错：後裡區（后→後、里→裡 双错）
    ['松山区', '松山區', '台北市'],   // 曾错：鬆山區（松→鬆）
    ['朴子市', '朴子市', '嘉義縣'],   // 曾错：樸子市（朴→樸）
    ['布袋镇', '布袋鎮', '嘉義縣'],   // 曾错：佈袋鎮（布→佈）
    ['皇后大道', '皇后大道', '香港'], // 曾错：皇後大道（后→後）
  ];
  for (const [input, expected, where] of cases) {
    assert.equal(toTraditional(input), expected, `${where} ${input}`);
  }
});

// =============================================
// 二、更多真实台港澳地名（扩大回归面）
// =============================================

test('台湾县市与乡镇地名', () => {
  const cases = [
    ['员林市', '員林市'],   // 彰化縣
    ['万华区', '萬華區'],   // 台北市
    ['内湖区', '內湖區'],   // 台北市
    ['龙井区', '龍井區'],   // 台中市
    ['丰原区', '豐原區'],   // 台中市
    ['恒春镇', '恆春鎮'],   // 屏東縣
    ['头份市', '頭份市'],   // 苗栗縣
    ['草屯镇', '草屯鎮'],   // 南投縣
    ['新店区', '新店區'],   // 新北市
    ['礁溪乡', '礁溪鄉'],   // 宜蘭縣
    ['东势区', '東勢區'],   // 台中市
    ['西屯区', '西屯區'],   // 台中市
  ];
  for (const [input, expected] of cases) {
    assert.equal(toTraditional(input), expected, input);
  }
});

test('港澳地名', () => {
  const cases = [
    ['弥敦道', '彌敦道'],
    ['深水埗', '深水埗'],   // 埗 简繁同形
    ['油尖旺区', '油尖旺區'],
    ['澳门', '澳門'],
    ['路氹城', '路氹城'],
    ['旺角', '旺角'],
    ['铜锣湾', '銅鑼灣'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(toTraditional(input), expected, input);
  }
});

test('含「台」地名按 OpenCC 标准转为正体「臺」', () => {
  // OpenCC s2t 标准词典将「台」规范为正体「臺」（台湾教育部官方写法，
  // 「臺北市/臺東縣」为正式写法，非错误）；已是「臺」的输入原样保留。
  assert.equal(toTraditional('台东区'), '臺東區');
  assert.equal(toTraditional('台北市'), '臺北市');
  assert.equal(toTraditional('臺中市'), '臺中市');
});

// =============================================
// 三、简繁混杂输入：已是繁体的部分必须原样保留
// （GeoNames zh 数据简繁混杂，繁体字不在简→繁词典中）
// =============================================

test('繁体输入保持不变（数据简繁混杂场景）', () => {
  const cases = ['板橋區', '松山區', '斗六市', '后里區', '皇后大道', '深水埗區', '彌敦道', '萬華區'];
  for (const hant of cases) {
    assert.equal(toTraditional(hant), hant, `繁体 ${hant} 不应被改写`);
  }
});

// =============================================
// 四、一对多词组级语义（单字表做不到的核心能力）
// =============================================

test('一对多：按词义选择正确的繁体', () => {
  // 板：木板(板) vs 老板(闆)
  assert.equal(toTraditional('木板'), '木板');
  assert.equal(toTraditional('老板'), '老闆');
  // 后：皇后(后) vs 后来(後)
  assert.equal(toTraditional('皇后'), '皇后');
  assert.equal(toTraditional('后来'), '後來');
  // 斗：北斗(斗) vs 斗争(鬥)
  assert.equal(toTraditional('北斗'), '北斗');
  assert.equal(toTraditional('斗争'), '鬥爭');
  // 布：布料(布) vs 公布(佈)
  assert.equal(toTraditional('布料'), '布料');
  assert.equal(toTraditional('公布'), '公佈');
  // 松：松山(松) vs 松树(鬆)
  assert.equal(toTraditional('松山'), '松山');
  assert.equal(toTraditional('松树'), '松樹');
  // 里：公里(里) vs 里长(里，台湾行政区划用「里」)
  assert.equal(toTraditional('公里'), '公里');
  // 朴：朴子(朴) vs 朴素(樸)
  assert.equal(toTraditional('朴素'), '樸素');
});

// =============================================
// 五、边界行为（与原实现的守卫语义一致，geo.ts 依赖）
// =============================================

test('空值与非中文原样返回', () => {
  assert.equal(toTraditional(''), '');
  assert.equal(toTraditional('Beijing'), 'Beijing');
  assert.equal(toTraditional('Tokyo 101'), 'Tokyo 101');
  assert.equal(toTraditional('경주'), '경주');
});

test('isTraditionalChinese 语言标签判定', () => {
  for (const l of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'hant', 'ZH-HANT']) {
    assert.equal(isTraditionalChinese(l), true, l);
  }
  for (const l of ['zh', 'zh-CN', 'zh-SG', 'en', 'ja', '']) {
    assert.equal(isTraditionalChinese(l), false, l);
  }
});
