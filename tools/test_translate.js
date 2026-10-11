#!/usr/bin/env node
// translate.sgmodule（翻译合集）的检查：参数和脚本对得上。
//   - 脚本里用到的 {{{参数}}} 都在 #!arguments 里，#!arguments 里的参数都有用到，每个参数都有说明
//   - script-path 指向仓库里真有的脚本，argument 里的每个字段都是那个脚本 parseArgs 认识的
//   - 站点开关的默认值就是脚本名，不带空格和引号（会被原样换进脚本名）
//   - 几个脚本里的大模型代码和 scripts/lib/llm.js 一样
//
//   node tools/test_translate.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const text = fs.readFileSync(path.join(ROOT, 'translate.sgmodule'), 'utf8');
const meta = Object.fromEntries(text.split('\n').filter((l) => l.startsWith('#!')).map((l) => [l.slice(2, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const args = [...meta.arguments.matchAll(/([^:,]+):("[^"]*"|[^,]*)/g)].map((m) => ({ name: m[1], value: m[2] }));
const names = args.map((a) => a.name);
assert.strictEqual(new Set(names).size, names.length, '参数名不能重复');
const described = meta['arguments-desc'].split('\\n\\n').map((d) => d.split('\\n')[0]);
assert.deepStrictEqual(described, names, '#!arguments-desc 要按同样的顺序给每个参数写说明');

const section = (name) => (new RegExp(`\\[${name}\\]\\n([\\s\\S]*?)(?:\\n\\[|$)`).exec(text) || [])[1] || '';
const scripts = section('Script').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const used = new Set();
for (const line of scripts) {
  const [, name, rest] = /^(.+?) = (.*)$/.exec(line);
  for (const m of line.matchAll(/\{\{\{(.+?)\}\}\}/g)) {
    assert.ok(names.includes(m[1]), `「${m[1]}」没在 #!arguments 里`);
    used.add(m[1]);
  }
  const sw = /^\{\{\{(.+?)\}\}\}/.exec(name);
  assert.ok(sw, `脚本「${name}」要用站点开关当名字`);
  const value = args.find((a) => a.name === sw[1]).value;
  assert.ok(/^[^\s"#]+$/.test(value), `开关「${sw[1]}」的默认值不能有空格、引号：${value}`);

  const file = /script-path=https:\/\/raw\.githubusercontent\.com\/justyura\/surge-modules\/main\/(scripts\/[\w-]+\.js)/.exec(rest)[1];
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const defaults = /function parseArgs\(raw\) \{\s*var args = \{([\s\S]*?)\};/.exec(code)[1];
  const known = [...defaults.matchAll(/(\w+):/g)].map((m) => m[1]);
  const argument = /argument="([^"]*)"/.exec(rest)[1];
  for (const part of argument.split('&')) {
    const key = part.split('=')[0];
    assert.ok(known.includes(key), `${file} 不认识参数 ${key}`);
  }
}
const unused = names.filter((n) => !used.has(n));
assert.deepStrictEqual(unused, [], '这些参数没用到：' + unused.join('、'));
assert.ok(/^hostname = %APPEND% /m.test(section('MITM')));
console.log(`ok  ${names.length} 个参数、${scripts.length} 个脚本都对得上`);

execFileSync('python3', [path.join(__dirname, 'sync_llm.py'), '--check'], { stdio: 'inherit' });
console.log('translate: all tests passed');
