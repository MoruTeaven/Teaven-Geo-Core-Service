/**
 * 简→繁中文转换工具
 *
 * 策略：数据库只存简体（zh），zh-Hant/zh-TW/zh-HK/zh-MO 请求时实时转换。
 *
 * 实现：opencc-js（nk2028 项目）词组级转换。
 * 历史教训：曾用手写 ~2500 组单字映射表（S2T_MAP[char] || char 逐字替换），
 * 但简繁转换大量存在一对多（板→闆/板、后→後/后、松→鬆/松、斗→鬥/斗……），
 * 单字表按字替换必然出错——真实台湾地名错误率 10/21（板橋→闆橋、
 * 松山→鬆山、斗六→鬥六、后里→後裡、皇后大道→皇後大道）。
 * opencc-js 按「词组优先、单字回退」转换，词组词典（STPhrases）保证
 * 皇后→皇后、老板→老闆、木板→木板 这类按词义的区分。
 *
 * 体积与兼容性（2026-11 实测）：opencc-js/cn2t 子入口（仅含简→繁词典）
 * esbuild bundle 2.10MB / gzip 0.494MB，无任何 Node API；wrangler deploy
 * --dry-run 实测 Total Upload 2089.70 KiB / gzip 515.53 KiB，Workers 免费
 * 计划上限（gzip 3MB）内。许可证：代码 MIT + 词典数据 Apache-2.0，均可商用。
 *
 * 为什么不用 chinese-conv（4.0.0，MIT，体积更小 582KB）：它只有单字映射级
 * 语义，在本 BUG 的 10 例真实地名上错 2 例（后里區→後裡區、皇后大道→皇後
 * 大道），一对多也错（老板→老板、公布→公布、朴素→朴素、公里→公裡）。
 * 选型以正确性优先，勿为省体积换回该库。
 */
import * as OpenCC from 'opencc-js/cn2t';

type Converter = (text: string) => string;

/** Worker isolate 内单例：词典构建有一次性开销，惰性初始化后复用 */
let converter: Converter | null = null;

function getConverter(): Converter {
  if (!converter) {
    // from 'cn'：GeoNames zh 数据以简体为主、简繁混杂；
    //   繁体字不在简→繁词典中，原样保留，故已是繁体的输入天然安全。
    // to 't'：OpenCC 标准简→繁（词组优先、单字回退）。注意标准词典会把
    //   「台」规范为正体「臺」（臺北市为台湾教育部正式写法，非错误）；
    //   zh-TW/zh-HK/zh-MO 共用；如需地区正体可再按 lang 分化 locale。
    converter = OpenCC.Converter({ from: 'cn', to: 't' });
  }
  return converter;
}

/**
 * 简体中文 → 繁体中文转换（词组级）
 * 未匹配的字符原样保留；已是繁体的输入保持不变
 */
export function toTraditional(text: string): string {
  if (!text) return text;
  return getConverter()(text);
}

/**
 * 判断是否为繁体中文请求
 *
 * 唯一实现在 utils/normalize.ts（语言标签判定属于归一化范畴），此处再导出
 * 以保持 s2t 模块自洽、兼容既有调用方。曾被复制成两份且口径不一致。
 */
export { isTraditionalChinese } from './normalize';
