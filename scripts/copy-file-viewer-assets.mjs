/**
 * 复制 file-viewer 自托管静态资产到 public/file-viewer(postinstall 自动执行)。
 *
 * 背景:在线预览(§issue17 调整单 docx、§issue18 附件)依赖 file-viewer 的
 * Worker/WASM/字体等浏览器侧资产。官方 CLI(file-viewer-copy-assets,devDependency)
 * 会全量复制所有渲染器资产(~165MB),其中 drawio/typst/CAD/3D 模型等项目无使用场景。
 * 这里先全量复制再裁剪,只保留 Word/PDF/xlsx 三类,体积降至 ~11MB。
 *
 * public/file-viewer 整体 gitignore 不入库:部署环境 npm install 时联网一次即可
 * 生成;CLI 内置 FILE_VIEWER_SKIP_ASSET_COPY=1 开关可跳过。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const target = path.join('public', 'file-viewer');

// 直接解析 CLI 的 JS 入口执行(不依赖 PATH:脚本可能在 npm scripts 之外运行)。
const require = createRequire(import.meta.url);
const cliPkgPath = require.resolve('file-viewer-copy-assets/package.json');
const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'));
// bin 可能是 string 或 { [name]: path }(多 bin),两种形态都兼容。
const cliBinRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : Object.values(cliPkg.bin ?? {})[0];
if (!cliBinRel) throw new Error('file-viewer-copy-assets 未声明 bin 入口');
const cliEntry = path.join(path.dirname(cliPkgPath), cliBinRel);
execFileSync(process.execPath, [cliEntry, target], { stdio: 'inherit' });

// 未使用的重型渲染器资产(drawio 66M、typst 37M、cad/model/ppt 等)。
// pdf 的 wasm/cmaps/fonts 在 vendor/pdf 自身子目录,不受 wasm/ 裁剪影响。
const unused = [
  'vendor/drawio',
  'vendor/hangul',
  'vendor/iwork',
  'vendor/libarchive',
  'vendor/ppt',
  'vendor/pptx',
  'vendor/wordperfect',
  'wasm/cad',
  'wasm/data',
  'wasm/model',
  'wasm/typst',
];
for (const rel of unused) {
  rmSync(path.join(target, ...rel.split('/')), { recursive: true, force: true });
}
