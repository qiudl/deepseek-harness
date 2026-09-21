#!/usr/bin/env node
/**
 * REQ-20260907-0016 D3: host-core-slark-sniff（required 门禁）。
 *
 * 按 REQ-20260907-0016 PRD v4 §5.1：
 * - corpus：packages/host、packages/core、packages/session、packages/interaction 的 src 运行时代码；
 * - 匹配原语：受控值域清单（仓库根 `.dsh-slark-value-domain.json` 中的字符串字面量值），
 *   命中运行期代码中的清单值即失败；注释/文档字符串文本不属扫描对象（跳过纯注释行与 JSDoc 块行）。
 * 默认清单为空 → 当前基线绿（core src=0、host 值域运行时命中 0–1 以清单定义为准）。
 * 退出码：0=通过；1=命中（PR 红）；2=用法/IO 错误。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOTS = ['packages/host', 'packages/core', 'packages/session', 'packages/interaction'];
const DEFAULT_CONFIG_PATH = '.dsh-slark-value-domain.json';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '';
}

function main() {
  const root = resolve(process.cwd());
  let config = [];
  try {
    config = JSON.parse(readFileSync(join(root, DEFAULT_CONFIG_PATH), 'utf8'));
    if (!Array.isArray(config) || config.some((v) => typeof v !== 'string' || v.length < 3)) {
      console.error(`[sniff] ${DEFAULT_CONFIG_PATH} must be a string array of value-domain literals`);
      process.exit(2);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // 默认无清单：基线绿
      console.log('[sniff] no value-domain config; baseline pass');
      process.exit(0);
    }
    console.error(`[sniff] cannot read ${DEFAULT_CONFIG_PATH}: ${error.message}`);
    process.exit(2);
  }

  const hits = [];
  const corpus = [];
  for (const rootDir of ROOTS) {
    const abs = join(root, rootDir);
    try {
      corpus.push(...walk(abs).map((f) => join(rootDir, f.slice(abs.length + 1))));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const rel of corpus) {
    const lines = readFileSync(join(root, rel), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return;
      for (const needle of config) {
        if (line.includes(needle)) hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 160)}`);
      }
    });
  }
  for (const hit of hits) console.log(`[sniff] HIT ${hit}`);
  console.log(`[sniff] corpus files=${corpus.length} hits=${hits.length}`);
  process.exit(hits.length === 0 ? 0 : 1);
}

main();
