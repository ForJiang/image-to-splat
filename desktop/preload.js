// preload：把主进程能力以 window.i2sDesktop 暴露给渲染进程。
//  contextIsolation 下唯一安全的通道；只暴露白名单方法，不直接给 Node 权限。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('i2sDesktop', {
  isDesktop: true,

  /** 原生多选图片对话框 → File[]（经 app://fs/ 读内容，前端与拖拽拿到的是同一种 File） */
  async openImages() {
    const specs = await ipcRenderer.invoke('dialog:openImages');
    return specs.map(s => toFile(s));
  },

  /** 原生图片/视频混合选择 → File[]（视频也走这里，前端按 type 分流） */
  async openMedia() {
    const specs = await ipcRenderer.invoke('dialog:openMedia');
    return specs.map(s => toFile(s));
  },

  /** 原生保存对话框 + 写盘；返回落盘路径或 null（取消） */
  async saveBlob(blob, suggestedName, extLabel) {
    const dest = await ipcRenderer.invoke('dialog:save', {
      suggested: suggestedName,
      filters: [{ name: extLabel || '文件', extensions: [suggestedName.split('.').pop() || '*'] }],
    });
    if (!dest) return null;
    const data = new Uint8Array(await blob.arrayBuffer());
    const written = await ipcRenderer.invoke('file:write', dest, data);
    return written;
  },

  /** 应用被「用 Image2Splat 打开」时，主进程把文件列表推过来 */
  onOpenFiles(cb) {
    // toFile 是异步读盘，必须等全部文件就绪再回调，否则页面拿到的是 Promise 数组
    const ch = async (_e, files) => cb(await Promise.all(files.map(s => toFile(s))));
    ipcRenderer.on('files:open', ch);
    return () => ipcRenderer.removeListener('files:open', ch);
  },
});

async function toFile(spec) {
  const res = await fetch('app://fs/' + encodeURIComponent(spec.path));
  const blob = await res.blob();
  return new File([blob], spec.name, { type: spec.mime });
}
