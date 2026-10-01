/**
 * 中英双语文案。静态文本用 data-i18n="key" 标注，动态文本用 t('key') 获取。
 */

const DICT = {
  zh: {
    'brand.tag': '图生 3D · 本地 · 免费',
    'hero.title': '把一张图片变成可旋转的 3D 点云',
    'hero.sub': '深度估计模型为每个像素估算距离，生成数十万枚带颜色的高斯「泼溅」——全部在浏览器里完成，图片不会上传到任何服务器。',
    'hero.badge.local': '100% 本地推理',
    'hero.badge.formats': 'JPG · PNG · MP4 · WebM',
    'hero.badge.oss': '免费 · 开源 · 无广告',
    'drop.title': '拖入图片或视频，或点击选择',
    'drop.sub': '视频会自动挑最清晰的帧；首次使用需下载约 50 MB 模型，之后有缓存',
    'options.quality': '重建分辨率',
    'options.quality.fast': '流畅（最快）',
    'options.quality.balanced': '均衡（推荐）',
    'options.quality.hd': '高清（较慢）',
    'options.strength': '深度强度',
    'options.size': '泼溅大小',
    'options.invert': '深度方向',
    'options.invert.near': '前景凸出（默认）',
    'options.invert.far': '背景凸出（对调）',
    'action.rebuild': '重建 3D 点云',
    'action.ply': '导出 .ply',
    'action.splat': '导出 .splat',
    'action.depth': '深度图 PNG',
    'source.title': '源与深度',
    'source.input': '输入',
    'source.depth': '深度图',
    'source.empty': '还没有文件——把图片拖上来，或试试示例：',
    'source.sampleAloe': '盆栽',
    'source.sampleAlley': '夜巷',
    'source.frameNote': '视频已自动选取最清晰的帧，点击缩略图可换帧重建。',
    'vp.title': '3D 预览',
    'vp.hint': '拖拽旋转，滚轮缩放；所有计算都在本机完成。',
    'vp.orbit': '环绕',
    'vp.reset': '复位',
    'vp.shot': '截图',
    'summary.splats': '泼溅数量',
    'summary.infer': '推理耗时',
    'summary.build': '重建耗时',
    'faq.title': '常见问题',
    'faq.q1': '能重建出完整的 3D 模型吗？',
    'faq.a1': '不能完全。单张图片只有正面信息，生成的是「正面 + 深度浮雕」（2.5D），被遮挡的背面无法凭空还原，大角度旋转会露馅。完整的多视角 3D 高斯泼溅需要多角度照片加 GPU 训练（如 nerfstudio、Postshot）。',
    'faq.q2': '我的图片或视频会被上传吗？',
    'faq.a2': '不会。模型加载后，深度推理、点云构建、导出全部在你的浏览器里完成，断网也能用；页面没有任何上传代码，站点也没有后端。',
    'faq.q3': '首次使用为什么要等一会儿？',
    'faq.a3': '首次需要下载约 50 MB 的深度模型（随站点自托管，不依赖第三方 CDN），之后浏览器会缓存，二次访问基本秒开。推理本身通常只要几秒。',
    'faq.q4': '什么样的素材效果最好？',
    'faq.a4': '主体清晰、有明确前后层次的场景，比如人物、盆栽、建筑立面；背景杂乱或全平的图（如文档翻拍）立体感会弱。视频建议环绕物体拍摄，选物体正对镜头的一帧。',
    'faq.q5': '导出的 .ply / .splat 怎么用？',
    'faq.a5': '.splat 可直接拖入 SuperSplat 或 splat viewer 查看；.ply 是通用彩色点云，Blender、CloudCompare 等工具都能打开，可作为 3D 创作素材。',
    'footer.privacy': '无服务器 · 无日志 · 无追踪',
    'footer.made': '用 HTML + WebGL 手工制作',
    'lang.btn': 'EN',
    'lang.switched': '已切换为中文',
    'status.idle': '等待输入…',
    'status.parsing': '解析视频帧… {i}/{n}',
    'status.model': '加载深度模型… {pct}',
    'status.infer': '深度推理中…',
    'status.done': '完成',
    'status.error': '出错了，可重新选择文件',
    'toast.unsupported': '请选择图片或视频文件',
    'toast.sampleFailed': '示例加载失败：请通过 HTTP 服务访问本站',
    'toast.plyDownloaded': '✓ 已开始下载 .ply 点云',
    'toast.splatDownloaded': '✓ 已开始下载 .splat，可拖入 SuperSplat 查看',
    'toast.depthDownloaded': '✓ 深度图已开始下载',
    'toast.shotDownloaded': '✓ 当前视角截图已保存',
    'toast.needFirst': '先拖入一张图片或视频，再导出',
    'error.pipeline': '处理失败，请换一个文件试试',
    'error.video': '无法从该视频读取画面，请换 MP4/WebM 试试',
  },
  en: {
    'brand.tag': 'Image → 3D · Local · Free',
    'hero.title': 'Turn a single photo into a rotatable 3D point cloud',
    'hero.sub': 'A depth-estimation model measures the distance of every pixel and raises hundreds of thousands of colored gaussian "splats" — all inside your browser. No image ever leaves your device.',
    'hero.badge.local': '100% in-browser',
    'hero.badge.formats': 'JPG · PNG · MP4 · WebM',
    'hero.badge.oss': 'Free · Open source · No ads',
    'drop.title': 'Drop an image or video here, or click to choose',
    'drop.sub': 'Videos get their sharpest frame picked automatically; first visit downloads a ~50 MB model, cached afterwards',
    'options.quality': 'Resolution',
    'options.quality.fast': 'Fast (fastest)',
    'options.quality.balanced': 'Balanced (recommended)',
    'options.quality.hd': 'HD (slower)',
    'options.strength': 'Depth strength',
    'options.size': 'Splat size',
    'options.invert': 'Depth direction',
    'options.invert.near': 'Foreground pops (default)',
    'options.invert.far': 'Background pops (flipped)',
    'action.rebuild': 'Rebuild point cloud',
    'action.ply': 'Export .ply',
    'action.splat': 'Export .splat',
    'action.depth': 'Depth map PNG',
    'source.title': 'Source & depth',
    'source.input': 'Input',
    'source.depth': 'Depth map',
    'source.empty': 'No files yet — drop an image above, or try a sample: ',
    'source.sampleAloe': 'Plant',
    'source.sampleAlley': 'Alley',
    'source.frameNote': 'The sharpest frame was picked automatically — click a thumbnail to rebuild from another one.',
    'vp.title': '3D preview',
    'vp.hint': 'Drag to orbit, scroll to zoom; everything runs on this device.',
    'vp.orbit': 'Orbit',
    'vp.reset': 'Reset',
    'vp.shot': 'Shot',
    'summary.splats': 'Splats',
    'summary.infer': 'Inference',
    'summary.build': 'Rebuild',
    'faq.title': 'FAQ',
    'faq.q1': 'Does this produce a full 3D model?',
    'faq.a1': 'Not fully. A single photo only carries the front view, so the result is a "front + depth relief" (2.5D) — occluded backsides can’t be invented, and steep orbits reveal it. True multi-view gaussian splatting needs many photos plus GPU training (nerfstudio, Postshot, etc.).',
    'faq.q2': 'Are my images or videos uploaded?',
    'faq.a2': 'No. Once the model is loaded, inference, cloud building and exporting all happen in your browser — it even works offline. The page contains no upload code and the site has no backend.',
    'faq.q3': 'Why does the first run take a while?',
    'faq.a3': 'The first run downloads a ~50 MB depth model (self-hosted with the site, no third-party CDN); the browser caches it afterwards, so revisit is nearly instant. Inference itself usually takes a few seconds.',
    'faq.q4': 'What kind of photos work best?',
    'faq.a4': 'Clear subjects with obvious depth layering — people, plants, building facades. Cluttered or flat shots (like documents) lose the 3D feel. For videos, orbit the object and pick the frame facing the camera.',
    'faq.q5': 'How do I use the exported .ply / .splat?',
    'faq.a5': 'Drop the .splat straight into SuperSplat or a splat viewer; the .ply is a standard colored point cloud that Blender, CloudCompare and friends open happily.',
    'footer.privacy': 'No server · No logs · No tracking',
    'footer.made': 'Handmade with HTML + WebGL',
    'lang.btn': '中文',
    'lang.switched': 'Switched to English',
    'status.idle': 'Waiting for input…',
    'status.parsing': 'Parsing video frames… {i}/{n}',
    'status.model': 'Loading depth model… {pct}',
    'status.infer': 'Inferring depth…',
    'status.done': 'Done',
    'status.error': 'Something went wrong — pick another file',
    'toast.unsupported': 'Please choose an image or a video file',
    'toast.sampleFailed': 'Failed to load the sample: open this site over HTTP',
    'toast.plyDownloaded': '✓ .ply point cloud download started',
    'toast.splatDownloaded': '✓ .splat download started — drop it into SuperSplat',
    'toast.depthDownloaded': '✓ Depth map download started',
    'toast.shotDownloaded': '✓ Viewport screenshot saved',
    'toast.needFirst': 'Drop an image or video first, then export',
    'error.pipeline': 'Processing failed — try another file',
    'error.video': 'Could not read frames from this video — try MP4/WebM',
  },
};

const LANG_KEY = 'i2s-lang';
let lang = 'zh';

export function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* 隐私模式下 localStorage 不可用 */ }
  return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function getLang() { return lang; }

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  return lang;
}

/** 取文案；{name} / {n} 占位符会被 vars 替换 */
export function t(key, vars) {
  let s = (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** 把文档里所有 data-i18n 元素的文本刷成当前语言 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const v = t(key);
    if (v && v !== key) el.textContent = v;
  });
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}
