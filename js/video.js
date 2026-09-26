// 视频处理：抽帧 + 拉普拉斯方差清晰度评分（自动挑最清晰的一帧）。
// 双路径：优先「按时长 seek 抽帧」（快、时间点准）；时长未知或 seek 失败
// （如 MediaRecorder/分片 MP4、部分 WebM）则降级为「边播放边采样」。

export async function extractFrames(file, { count = 16, maxSide = 640, onFrame } = {}) {
  try {
    return await seekFrames(file, { count, maxSide, onFrame });
  } catch (err) {
    console.warn('[video] seek 抽帧失败，降级为播放采样:', err);
    return await playFrames(file, { count, maxSide, onFrame });
  }
}

/* ---------- 路径一：seek 抽帧 ---------- */

async function seekFrames(file, { count, maxSide, onFrame }) {
  const url = URL.createObjectURL(file);
  const video = makeVideo(url);
  try {
    await once(video, 'loadedmetadata', 8000);
    await fixDuration(video);

    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('视频时长未知');

    // 部分 Safari 需要 start 过一次播放器才有可用的解码帧
    try { await video.play(); video.pause(); } catch { /* 忽略 */ }

    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(dur - 0.05, ((i + 0.5) / count) * dur);
      await seekTo(video, t); // 失败不跳过：整条路径交给上层降级
      frames.push(snapshot(video, maxSide, t));
      onFrame?.(i + 1, count);
    }
    if (!frames.length) throw new Error('未读取到画面');
    return frames;
  } finally {
    cleanup(video, url);
  }
}

// 分片 MP4 常见 duration=Infinity：跳到超大时间戳迫使浏览器解析出总时长
async function fixDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return;
  try {
    await new Promise((resolve) => {
      const done = () => { cleanup2(); resolve(); };
      const cleanup2 = () => {
        clearTimeout(timer);
        video.removeEventListener('durationchange', done);
        video.removeEventListener('seeked', done);
      };
      const timer = setTimeout(done, 2000);
      video.addEventListener('durationchange', done, { once: true });
      video.addEventListener('seeked', done, { once: true });
      video.currentTime = 1e101;
    });
  } catch { /* 忽略 */ }
  if (Number.isFinite(video.duration) && video.duration > 0) {
    try { await seekTo(video, 0); } catch { /* 忽略 */ }
  }
}

/* ---------- 路径二：播放采样 ---------- */

async function playFrames(file, { count, maxSide, onFrame }) {
  const url = URL.createObjectURL(file);
  const video = makeVideo(url);
  try {
    await once(video, 'loadedmetadata', 8000);
    await video.play();

    const samples = [];
    const useRVFC = typeof video.requestVideoFrameCallback === 'function';
    const interval = 0.2; // 每隔 ~0.2 秒采样一帧
    let lastT = -1;
    let wall = 0;

    await new Promise((resolve) => {
      const step = () => {
        if (video.ended || samples.length >= 64 || wall > 30000) { resolve(); return; }
        if (video.currentTime >= lastT + interval && video.videoWidth > 0) {
          lastT = video.currentTime;
          samples.push(snapshot(video, maxSide, video.currentTime));
          onFrame?.(samples.length, Math.max(count, samples.length + 1));
        }
        wall += 40;
        if (useRVFC) video.requestVideoFrameCallback(step);
        else setTimeout(step, 40);
      };
      if (useRVFC) video.requestVideoFrameCallback(step);
      else setTimeout(step, 40);
      setTimeout(resolve, 45000); // 兜底
    });

    video.pause();
    if (!samples.length) throw new Error('无法从该视频读取画面，请换 MP4/WebM 试试');

    // 均匀挑出 count 帧
    if (samples.length > count) {
      const picked = [];
      for (let i = 0; i < count; i++) {
        picked.push(samples[Math.floor(((i + 0.5) / count) * samples.length)]);
      }
      return picked;
    }
    return samples;
  } finally {
    cleanup(video, url);
  }
}

/* ---------- 公共 ---------- */

function makeVideo(url) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  return video;
}

function snapshot(video, maxSide, t) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 360;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * scale));
  const h = Math.max(2, Math.round(vh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return { canvas, t, sharp: sharpness(canvas) };
}

function cleanup(video, url) {
  try {
    video.pause();
    video.removeAttribute('src');
    video.load();
  } catch { /* 忽略 */ }
  URL.revokeObjectURL(url);
}

function once(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener('error', bad);
      err ? reject(err) : resolve();
    };
    const ok = () => finish(null);
    const bad = () => finish(new Error('视频元数据读取失败'));
    const timer = setTimeout(() => finish(new Error('读取视频超时')), timeoutMs);
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', bad, { once: true });
  });
}

function seekTo(video, t) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', ok);
      video.removeEventListener('error', bad);
      err ? reject(err) : resolve();
    };
    const ok = () => finish(null);
    const bad = () => finish(new Error('seek failed'));
    const timer = setTimeout(() => finish(new Error('seek 超时')), 4000);
    video.addEventListener('seeked', ok, { once: true });
    video.addEventListener('error', bad, { once: true });
    video.currentTime = t;
  });
}

// 拉普拉斯方差：越大越清晰（对焦越好、细节越多）
function sharpness(canvas) {
  const w = 96;
  const h = Math.max(4, Math.round((canvas.height / canvas.width) * w));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  let sum = 0, sum2 = 0, m = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sum2 += l * l; m++;
    }
  }
  if (!m) return 0;
  const mean = sum / m;
  return sum2 / m - mean * mean;
}
