// 发布助手的媒体处理：浏览器内压缩视频（WebCodecs，经 mediabunny）
// （视频压缩部分与投票网站 Di-90/volleyball-vote 的 uploader.js 相同）
import { Input, Output, Conversion, CanvasSink, ALL_FORMATS, BlobSource, BufferTarget, Mp4OutputFormat } from './vendor/mediabunny.min.mjs';

export const supported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

const REASON = {
  undecodable_source_codec: '这台电脑的浏览器解不开该视频的编码（常见于 HEVC/H.265），请换一台较新的电脑或用 Chrome/Edge 最新版',
  no_encodable_target_codec: '浏览器不支持编码 H.264，请换用最新版 Chrome 或 Edge',
  unknown_source_codec: '无法识别的视频编码',
};

// 压缩：长边不超过 1280、30 帧、H.264 约 0.65 Mbps；音频能直接复制就复制（手机视频一般是 AAC），否则转 AAC
// 已符合要求的视频（≤720p、H.264、AAC/无声、≤30 帧、总码率≤1.2 Mbps、mp4/mov）只重新封装，不动画面，几秒完成
export async function compress(file, onProgress) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('文件里没有视频画面');
  const at = await input.getPrimaryAudioTrack();
  const landscape = vt.displayWidth >= vt.displayHeight;
  const long = Math.max(vt.displayWidth, vt.displayHeight);
  const fps = (await vt.computePacketStats(120).catch(() => null))?.averagePacketRate || 30;
  const dur = await input.computeDuration().catch(() => 0);
  const kbps = dur ? file.size * 8 / dur / 1000 : Infinity;
  const skip = /\.(mp4|m4v|mov)$/i.test(file.name) && vt.codec === 'avc' && long <= 1280 && fps <= 31
    && (!at || at.codec === 'aac') && kbps <= 1200;
  const size = long > 1280 ? (landscape ? { width: 1280 } : { height: 1280 }) : {};
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // 浏览器多用显卡编码器，同码率下效率不如 x264，故码率给低一些，体积与脚本版相当
  const conv = await Conversion.init({
    input, output, tracks: 'primary', showWarnings: false,
    video: skip ? {} : { ...size, ...(fps > 31 ? { frameRate: 30 } : {}), codec: 'avc', bitrate: 650_000, forceTranscode: true },
    audio: skip ? {} : { codec: 'aac' },
  });
  const lostVideo = conv.discardedTracks.find(d => d.track.isVideoTrack());
  if (!conv.isValid || lostVideo) throw new Error(REASON[lostVideo && lostVideo.reason] || '浏览器无法处理这个视频');
  const lostAudio = conv.discardedTracks.some(d => d.track.isAudioTrack());
  conv.onProgress = p => onProgress && onProgress(p);
  await conv.execute();
  return { blob: new Blob([output.target.buffer], { type: 'video/mp4' }), noAudio: lostAudio, skipped: skip };
}

// 封面：取第 1 秒（短视频取中间）一帧，长边 640 的 JPEG
// 用解码器直接取帧（不依赖 <video> 播放器，后者在页面外常常不解码、截到黑屏或卡住）
export async function poster(blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const vt = await input.getPrimaryVideoTrack();
  const dur = await vt.computeDuration();
  const k = Math.min(1, 640 / Math.max(vt.displayWidth, vt.displayHeight));
  const sink = new CanvasSink(vt, { width: Math.round(vt.displayWidth * k), height: Math.round(vt.displayHeight * k), fit: 'contain' });
  const frame = await sink.getCanvas(Math.min(1, dur / 2));
  if (!frame) return null;
  const c = frame.canvas;
  return c.convertToBlob ? c.convertToBlob({ type: 'image/jpeg', quality: 0.8 }) : new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.8));
}
