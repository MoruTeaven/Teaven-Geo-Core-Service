/**
 * GeoNames 数据下载与预处理脚本
 * 
 * 使用方式：
 *   node scripts/download-geoname.js
 * 
 * 数据来源：
 *   - allCountries.zip         (所有地理点)
 *   - admin1CodesASCII.txt     (一级行政区划)
 *   - admin2Codes.txt          (二级行政区划)
 *   - alternateNamesV2.zip     (多语言别名，含中英日)
 *   - hierarchy.zip            (层级关系)
 *   - countryInfo.txt          (国家信息)
 * 
 * 输出：
 *   data/raw/   - 原始下载文件
 *   data/processed/ - 处理后的数据文件
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(PROJECT_ROOT, 'data', 'raw');
const PROCESSED_DIR = path.join(PROJECT_ROOT, 'data', 'processed');

// GeoNames 数据文件
const GEONAME_BASE = 'https://download.geonames.org/export/dump/';
const FILES = [
  'allCountries.zip',
  'admin1CodesASCII.txt',
  'admin2Codes.txt',
  'alternateNamesV2.zip',
  'hierarchy.zip',
  'countryInfo.txt',
];

// 确保目录存在
[RAW_DIR, PROCESSED_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

/**
 * 下载文件
 */
async function downloadFile(filename) {
  const url = GEONAME_BASE + filename;
  const dest = path.join(RAW_DIR, filename);

  if (fs.existsSync(dest)) {
    console.log(`  [SKIP] ${filename} already exists`);
    return;
  }

  console.log(`  [DOWNLOAD] ${filename} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${filename}: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  console.log(`  [OK] ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * 解压 zip 文件（跨平台）
 *
 * 策略（按顺序尝试）：
 *   1. tar -xf            —— Windows 10 1803+ / macOS / Linux 均自带 bsdtar，可解 zip
 *   2. unzip -o           —— Linux/macOS 常见
 *   3. powershell Expand-Archive —— 仅 Windows 兜底
 */
function unzip(filename) {
  const zipPath = path.join(RAW_DIR, filename);
  if (!fs.existsSync(zipPath)) {
    console.log(`  [SKIP] ${filename} not found for unzip`);
    return;
  }

  const baseName = filename.replace('.zip', '');
  const extracted = path.join(RAW_DIR, baseName);

  // 检查是否已解压
  const possibleFiles = [
    path.join(RAW_DIR, baseName + '.txt'),
    path.join(RAW_DIR, baseName),
  ];
  if (possibleFiles.some(f => fs.existsSync(f))) {
    console.log(`  [SKIP] ${filename} already extracted`);
    return;
  }

  console.log(`  [UNZIP] ${filename} ...`);

  const attempts = [
    { label: 'tar', cmd: `tar -xf "${zipPath}" -C "${RAW_DIR}"` },
    { label: 'unzip', cmd: `unzip -o "${zipPath}" -d "${RAW_DIR}"` },
    {
      label: 'powershell Expand-Archive',
      cmd: `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${RAW_DIR}' -Force"`,
    },
  ];

  for (const attempt of attempts) {
    try {
      execSync(attempt.cmd, { stdio: 'pipe' });
      if (possibleFiles.some(f => fs.existsSync(f))) {
        console.log(`  [OK] ${filename} extracted (via ${attempt.label})`);
        return;
      }
      console.log(`  [WARN] ${attempt.label} ran but produced no output, trying next`);
    } catch (e) {
      console.log(`  [WARN] ${attempt.label} unavailable or failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.error(`  [ERROR] Could not unzip ${filename}. Please extract it manually:`);
  console.error(`          ${zipPath} -> ${RAW_DIR}`);
  process.exit(1);
}

/**
 * 主流程
 */
async function main() {
  console.log('=== GeoNames Data Download ===\n');

  // Step 1: 下载所有文件
  console.log('Step 1: Downloading files...');
  for (const file of FILES) {
    try {
      await downloadFile(file);
    } catch (e) {
      console.error(`  [ERROR] ${file}: ${e.message}`);
    }
  }

  // Step 2: 解压 zip 文件
  console.log('\nStep 2: Extracting zip files...');
  for (const file of FILES) {
    if (file.endsWith('.zip')) {
      unzip(file);
    }
  }

  console.log('\n=== Download complete ===');
  console.log(`Raw data: ${RAW_DIR}`);
  console.log('Next step: node scripts/process-geoname.js');
}

main().catch(console.error);
