import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import asyncToGenerator from '@babel/plugin-transform-async-to-generator';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => fs.readFile(path.join(root, relative));

async function collect(directory, prefix, entries) {
  for (const file of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${file.name}`;
    const target = `${prefix}/${file.name}`;
    if (file.isDirectory()) await collect(relative, target, entries);
    else if (file.isFile()) entries[target] = await read(relative);
  }
}

export async function moduleEntries() {
  const entries = { 'module.json': await read('module.json') };
  await collect('src/card', 'card', entries);
  await collect('src/webui', 'webroot', entries);
  const core = await read('src/shared/core.js');
  const renderer = await read('prototype/main.js');
  // 后台宿主只加载这一份入口，不解析 HTML；WebView 保持原生 async/await。
  entries['background/main.js'] = Buffer.concat([core, Buffer.from('\n'), await read('src/background/main.js')]);
  for (const target of ['card', 'webroot']) {
    entries[`${target}/core.js`] = core;
    entries[`${target}/renderer.js`] = renderer;
    await collect('prototype/assets', `${target}/assets`, entries);
    // SVG 来源文件不是卡片运行资源，实际显示继续使用静态 PNG。
    delete entries[`${target}/assets/openai-source.svg`];
  }
  entries['webroot/preview.html'] = await read('src/preview/index.html');
  entries['webroot/preview.js'] = await read('src/preview/main.js');
  // 与 rear-card-bridge/tools/card-build 相同：仅 card/*.js 转换 async/await。
  for (const name of Object.keys(entries)) {
    if (!name.startsWith('card/') || !name.endsWith('.js')) continue;
    try {
      const result = await transformAsync(entries[name].toString('utf8'), {
        babelrc: false, configFile: false, sourceType: 'script',
        sourceMaps: false, compact: false, plugins: [asyncToGenerator]
      });
      entries[name] = Buffer.from(result.code);
    } catch (error) {
      throw new Error(`编译失败 ${name}: ${error.message}`);
    }
  }
  return entries;
}

export async function buildModule() {
  const entries = await moduleEntries();
  const manifest = JSON.parse(entries['module.json'].toString());
  const output = path.join(root, 'dist', `ai-usage-${manifest.version}.zip`);
  const zip = zipSync(entries);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, zip);
  // 仓库导入不执行构建：根目录同步提交与 ZIP 完全一致的静态模块。
  // module.json 本身就是根目录源码，不重复覆盖。
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'module.json') continue;
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
  return { output, entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, entries } = await buildModule();
  console.log(`模块已生成：${path.relative(root, output)}（${Object.keys(entries).length} 个文件）`);
}
