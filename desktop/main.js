// Electron 主进程。Web 版是同一套前端代码——这里只做三件事：
// 1) 用 app:// 自定义协议把仓库静态文件（index.html / assets / models）提供给渲染进程，
//    让 ES module、fetch、wasm、WebGPU 全部按 http 语义工作（file:// 下会被 CORS 卡死）；
// 2) 原生打开/保存对话框（图片多选、导出 .ply/.splat/PNG）；
// 3) 响应「用 Image2Splat 打开」（Finder 右键 / open -a ... 文件 / 命令行直启），
//    把文件喂给前端同一入口。
//
// 模型不下载：models/ 通过 --extra-resource 打进 .app，随包分发，完全离线可用。

const { app, BrowserWindow, dialog, ipcMain, protocol, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 开发态（electron . 从 desktop/ 跑）直接指向仓库根；打包后资源在 Contents/Resources
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');

// 自定义协议必须先注册为 privileged，浏览器才会把它当 http 一样对待
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// 启动开关必须赶在 app ready 之前：
// WebGPU 在部分 Electron 版本默认关闭（老参数在新版被忽略，加了无害）；
// I2S_DEBUG_PORT 留一个 CDP 口用于自动化验证打包产物，默认关闭。
app.commandLine.appendSwitch('enable-unsafe-webgpu');
if (process.env.I2S_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.I2S_DEBUG_PORT);

// 原生对话框选中/命令行传入的文件路径白名单：渲染进程只能经 app://fs/ 读到用户亲手选过的文件
const allowedFsPaths = new Set();

// 扩展名 → MIME：既服务 app:// 静态文件（wasm/JS 的 MIME 必须显式给对，
// 否则 WebAssembly.instantiateStreaming 与 module 加载会出问题），
// 也用于原生对话框选中文件时构造 File 的 type
const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
};

let win = null;

// 待送达渲染进程的文件（open-file AppleEvent、second-instance 转交、命令行直启三条来路汇总）
let pendingOpen = [];
const flushOpen = () => {
  if (!win || pendingOpen.length === 0) return;
  const files = pendingOpen;
  pendingOpen = [];
  win.webContents.send('files:open', files.map(p => ({
    path: p,
    name: path.basename(p),
    mime: MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream',
  })));
};

function takeFileArgs(argv, skip) {
  for (const arg of argv.slice(skip)) {
    try {
      if (fs.statSync(arg).isFile()) { allowedFsPaths.add(arg); pendingOpen.push(arg); }
    } catch { /* 普通开关参数 */ }
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Image2Splat',
    backgroundColor: '#0a0a0c', // 与站点底色一致，避免启动白闪
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.loadURL('app://bundle/index.html');
  win.on('closed', () => { win = null; });
}

function boot() {
  app.whenReady().then(() => {
    protocol.handle('app', async (req) => {
      let u;
      try { u = new URL(req.url); } catch { return new Response('Bad request', { status: 400 }); }
      let filePath;
      if (u.host === 'fs') {
        // app://fs/<整体 encodeURIComponent 的绝对/相对路径>
        const p = decodeURIComponent(u.pathname.slice(1));
        if (!allowedFsPaths.has(p)) return new Response('Forbidden', { status: 403 });
        filePath = path.resolve(p);
      } else {
        // app://bundle/<页面路径> —— 应用自带资源
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
        filePath = path.join(ROOT, rel);
        if (!isInside(ROOT, filePath)) return new Response('Forbidden', { status: 403 });
      }
      try {
        if (fs.statSync(filePath).isDirectory()) return new Response('Not found', { status: 404 });
      } catch { return new Response('Not found', { status: 404 }); }
      // 直接读盘返回：Electron 的 net.fetch 对 file:// 支持不稳，这里自己兜底
      const body = fs.readFileSync(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'content-length': String(body.length),
          'cache-control': 'no-cache',
        },
      });
    });

    // ---- 原生对话框 ----
    ipcMain.handle('dialog:openImages', async () => {
      const r = await dialog.showOpenDialog(win, {
        title: '选择照片（多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (r.canceled) return [];
      for (const p of r.filePaths) allowedFsPaths.add(p);
      return r.filePaths.map(p => ({ path: p, name: path.basename(p), mime: MIME_BY_EXT[path.extname(p).toLowerCase()] || 'image/png' }));
    });

    ipcMain.handle('dialog:openMedia', async () => {
      // 视频走站点现有视频链路：同图多选，交给前端按 type 分流
      const r = await dialog.showOpenDialog(win, {
        title: '选择图片或视频',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
          { name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (r.canceled) return [];
      for (const p of r.filePaths) allowedFsPaths.add(p);
      return r.filePaths.map(p => ({ path: p, name: path.basename(p), mime: MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream' }));
    });

    ipcMain.handle('dialog:save', async (_e, { suggested, filters }) => {
      const r = await dialog.showSaveDialog(win, { title: '导出', defaultPath: suggested, filters });
      return r.canceled || !r.filePath ? null : r.filePath;
    });

    ipcMain.handle('file:write', async (_e, dest, data) => {
      // data 为渲染进程传来的 Uint8Array；目标目录不存在时补建
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(data));
      return dest;
    });

    // ---- 「用 Image2Splat 打开」三条来路 ----
    app.on('open-file', (e, p) => {
      e.preventDefault();
      allowedFsPaths.add(p);
      pendingOpen.push(p);
      flushOpen(); // 应用已在前台时立即送达；未就绪则等 did-finish-load 再冲一次
    });
    // 命令行直启（./Image2Splat.app/Contents/MacOS/Image2Splat a.jpg b.jpg）：参数即文件
    takeFileArgs(process.argv, app.isPackaged ? 1 : 2);
    app.on('web-contents-created', (_e, contents) => {
      contents.on('did-finish-load', flushOpen);
    });

    createWindow();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu', label: app.name },
      { role: 'editMenu', label: '编辑' },
      { role: 'viewMenu', label: '视图' },
      { role: 'windowMenu', label: '窗口' },
    ]));

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

// 单实例锁：重复启动（Finder 双击/命令行/open -a）时第二个实例把参数转交给第一个，
// 否则带文件参数的二次启动会被静默丢弃（文件丢失且无任何提示）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // argv[0] 是可执行文件路径，其余是第二个实例命令行里收到的文件
    takeFileArgs(argv, 1);
    flushOpen();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  boot();
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
