// 发布助手的媒体处理：浏览器内压缩视频（WebCodecs，经 mediabunny）
// （视频压缩部分与投票网站 Di-90/volleyball-vote 的 uploader.js 相同）
import { Input, Output, Conversion, CanvasSink, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat } from './vendor/mediabunny.min.mjs';

export const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

const REASON = {
  undecodable_source_codec: '这台电脑的浏览器解不开该视频的编码（常见于 HEVC/H.265），请换一台较新的电脑或用 Chrome/Edge 最新版',
  no_encodable_target_codec: '浏览器不支持编码 H.264，请换用最新版 Chrome 或 Edge',
  unknown_source_codec: '无法识别的视频编码',
};

// 两档画质：
//   standard（新闻、赛事）：长边 ≤1280、30 帧、H.264 约 0.65 Mbps；已是 ≤720p、≤1.2 Mbps 的 H.264 只重新封装
//   high（排球课堂、风采相册）：长边 ≤1920（1080p）、30 帧、约 3 Mbps；已是 ≤1080p 的 H.264 且文件不超过上限的，直接用原片
// 音频能直接复制就复制（手机视频一般是 AAC），否则转 AAC
// watermark：传入文字（如 BISTU-Volleyball）时把它烧进画面右下角，此时一律重新压缩（不走"直接用原片"的快捷路径）
export const PROFILES = {
  standard: { long: 1280, bitrate: 650_000, skipKbps: 1200, maxMB: 50 },
  high: { long: 1920, bitrate: 3_000_000, skipKbps: Infinity, maxMB: 70 },
};
export async function compress(file, onProgress, watermark, quality = 'standard') {
  const P = PROFILES[quality] || PROFILES.standard;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('文件里没有视频画面');
  const at = await input.getPrimaryAudioTrack();
  const landscape = vt.displayWidth >= vt.displayHeight;
  const long = Math.max(vt.displayWidth, vt.displayHeight);
  const fps = (await vt.computePacketStats(120).catch(() => null))?.averagePacketRate || 30;
  const dur = await input.computeDuration().catch(() => 0);
  const kbps = dur ? file.size * 8 / dur / 1000 : Infinity;
  const skip = !watermark && /\.(mp4|m4v|mov)$/i.test(file.name) && vt.codec === 'avc' && long <= P.long
    && (quality === 'high' ? fps <= 61 && file.size <= P.maxMB * 1048576 : fps <= 31 && kbps <= P.skipKbps)
    && (!at || at.codec === 'aac');
  const size = long > P.long ? (landscape ? { width: P.long } : { height: P.long }) : {};
  const video = { ...size, ...(fps > 31 ? { frameRate: 30 } : {}), codec: 'avc', bitrate: P.bitrate, forceTranscode: true };
  if (watermark) {
    // 自己按输出尺寸画每一帧：先画原画面（drawWithFit 会处理手机视频的旋转），再写水印
    const k = Math.min(1, P.long / long), even = x => Math.max(2, Math.round(x / 2) * 2);
    const W = even(vt.displayWidth * k), H = even(vt.displayHeight * k);
    const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d');
    const fs = Math.round(Math.min(W, H) * 0.045), pad = Math.round(fs * 0.8);
    delete video.width; delete video.height;
    Object.assign(video, {
      processedWidth: W, processedHeight: H,
      process: sample => {
        sample.drawWithFit(ctx, { fit: 'fill' });
        ctx.font = `bold ${fs}px system-ui, "Segoe UI", sans-serif`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = fs * 0.25; ctx.shadowOffsetY = fs * 0.05;
        ctx.fillStyle = 'rgba(255,255,255,.7)';
        ctx.fillText(watermark, W - pad, H - pad);
        ctx.shadowColor = 'transparent';
        return cv;
      },
    });
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // 浏览器多用显卡编码器，同码率下效率不如 x264，故码率给低一些，体积与脚本版相当
  const conv = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    video: skip ? {} : video,
    audio: skip ? {} : { codec: 'aac' },
  });
  const lostVideo = conv.discardedTracks.find(d => d.track.isVideoTrack());
  if (!conv.isValid || lostVideo) throw new Error(REASON[lostVideo && lostVideo.reason] || '浏览器无法处理这个视频');
  const lostAudio = conv.discardedTracks.some(d => d.track.isAudioTrack());
  conv.onProgress = p => onProgress && onProgress(p);
  await conv.execute();
  return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), noAudio: lostAudio, skipped: skip };
}

// 封面：取第 1 秒（短视频取中间）一帧，长边 maxLong（默认 640）的 JPEG
// 用解码器直接取帧（不依赖 <video> 播放器，后者在页面外常常不解码、截到黑屏或卡住）
export async function poster(blob, maxLong = 640) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const vt = await input.getPrimaryVideoTrack();
  const dur = await vt.computeDuration();
  const k = Math.min(1, maxLong / Math.max(vt.displayWidth, vt.displayHeight));
  const sink = new CanvasSink(vt, { width: Math.round(vt.displayWidth * k), height: Math.round(vt.displayHeight * k), fit: 'contain' });
  const frame = await sink.getCanvas(Math.min(1, dur / 2));
  if (!frame) return null;
  const c = frame.canvas;
  const q = maxLong > 640 ? 0.88 : 0.8;
  return c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality: q }) : new Promise(ok => c.toBlob(ok, 'image/jpeg', q));
}
