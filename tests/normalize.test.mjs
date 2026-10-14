/**
 * 归一化规则回归测试
 *
 * 锁定 shared/normalize.mjs 的行为，防止「写库」与「查询」两侧再次分叉。
 * 运行：node --test tests/   或   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizeSearchTerm } from '../shared/normalize.mjs';

test('只去词尾后缀，不去词首（历史 BUG 回归）', () => {
  // 「市/县/区」在地名开头属于名称本身，不可剥离
  assert.equal(normalizeName('市南区'), '市南');
  assert.equal(normalizeName('市北区'), '市北');
  assert.equal(normalizeName('县前街'), '县前街');
  assert.equal(normalizeName('区家村'), '区家');
  assert.equal(normalizeName('市中区'), '市中');
  // 英文同样只去词尾
  assert.equal(normalizeName('City of London'), 'city of london');
  assert.equal(normalizeName('District of Columbia'), 'district of columbia');
  assert.equal(normalizeName('State of Texas'), 'state of texas');
});

test('正常后缀被正确剥离', () => {
  assert.equal(normalizeName('北京市'), '北京');
  assert.equal(normalizeName('山东省'), '山东');
  assert.equal(normalizeName('内蒙古自治区'), '内蒙古');
  assert.equal(normalizeName('香港特别行政区'), '香港');
  assert.equal(normalizeName('New York City'), 'new york');
  assert.equal(normalizeName('東京都'), '東京');
  assert.equal(normalizeName('大阪府'), '大阪');
});

test('长后缀优先于短后缀', () => {
  assert.equal(normalizeName('内蒙古自治区'), '内蒙古'); // 自治区 优先于 区
  assert.equal(normalizeName('香港特别行政区'), '香港'); // 特别行政区 优先于 区
});

test('纯后缀词回退为原值，绝不返回空串', () => {
  for (const w of ['省', '市', '区', '自治区', '自治县', '自治州', '特别行政区', 'city', 'county']) {
    assert.notEqual(normalizeName(w), '', w + ' 不应归一化为空串');
    assert.equal(normalizeName(w), w.toLowerCase());
  }
});

test('大小写与空白处理', () => {
  assert.equal(normalizeName('  Beijing  '), 'beijing');
  assert.equal(normalizeName('New   York'), 'new york');
  assert.equal(normalizeName('SÃO PAULO'), 'são paulo');
  assert.equal(normalizeName('St. Petersburg'), 'st. petersburg');
});

test('中文/日文不会被误删（历史 [^\w\s-] 过滤 BUG 回归）', () => {
  // 曾因 [^\w\s\-] 把中日韩字符全部剔除，导致 name_norm 全为空
  assert.equal(normalizeName('北京'), '北京');
  assert.equal(normalizeName('城关'), '城关');
  assert.equal(normalizeName('中正里'), '中正里');
  assert.equal(normalizeName('ワシントン郡'), 'ワシントン');
  assert.equal(normalizeName('華盛頓縣'), '華盛頓');
});

test('normalizeSearchTerm 与 normalizeName 完全一致', () => {
  const samples = ['市南区', '北京市', 'City of London', '東京都', '省', '  Beijing  ', '中正里'];
  for (const s of samples) {
    assert.equal(normalizeSearchTerm(s), normalizeName(s), s);
  }
});

test('边界输入不抛异常', () => {
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('   '), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});
