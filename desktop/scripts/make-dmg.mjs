// 把 electron-packager 产出的 Image2Splat.app 打成 .dmg（macOS 自带 hdiutil，零额外依赖）。
// 用法： npm run build:dmg
// 结构：临时目录里放 Image2Splat.app + /Applications 快捷方式（拖拽安装的标准布局）。

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const DESKTOP = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST = join(DESKTOP, 'dist');
const { version } = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(DESKTOP, 'package.json'), 'utf8')));

// packager 的输出在 dist/<name>-<platform>-<arch>/ 子目录里，往下找一层
function findApp(dir, depth = 0) {
  if (depth > 2) return null;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e.endsWith('.app') && statSync(p).isDirectory()) return p;
    if (statSync(p).isDirectory()) {
      const hit = findApp(p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
const APP_PATH = findApp(DIST);
if (!APP_PATH) {
  console.error('dist/ 下没有找到 .app，请先执行 npm run build');
  process.exit(1);
}
const NAME = APP_PATH.split('/').pop().replace(/\.app$/, '');
const STAGE = join(DIST, '.dmg-stage');
const DMG = join(DIST, `${NAME}-${version}-arm64.dmg`);

const app = APP_PATH.split('/').pop();
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(APP_PATH, join(STAGE, app), { recursive: true });
symlinkSync('/Applications', join(STAGE, 'Applications'), 'dir');

execSync(`hdiutil create -volname "${NAME}" -srcfolder "${STAGE}" -ov -format UDZO "${DMG}"`, { stdio: 'inherit' });
rmSync(STAGE, { recursive: true, force: true });

const mb = (statSync(DMG).size / 1048576).toFixed(1);
console.log(`dmg written: ${DMG} (${mb} MB)`);
