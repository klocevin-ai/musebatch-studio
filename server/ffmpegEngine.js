import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FFMPEG_PATH, FFPROBE_PATH, getResolutionForAspect } from './config.js';

export function runProcess(binary, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error('Tiến trình FFmpeg đã bị hủy.'));
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Không chạy được ${binary}: ${err.message}`));
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-10).join('\n');
        reject(new Error(`FFmpeg lỗi (exit ${code}):\n${tail}`));
      }
    });
  });
}

/**
 * Probe media file duration, resolution, and audio track presence using ffprobe.
 */
export async function probeMedia(filePath) {
  const { stdout } = await runProcess(FFPROBE_PATH, [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);

  const info = JSON.parse(stdout || '{}');
  const streams = info.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const duration =
    Number(info.format?.duration) ||
    Number(videoStream?.duration) ||
    Number(audioStream?.duration) ||
    0;

  return {
    duration,
    width: Number(videoStream?.width) || 0,
    height: Number(videoStream?.height) || 0,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream)
  };
}

/**
 * Escape file path for FFmpeg libass filter on Windows (C:/path -> C\:/path).
 */
function escapeFilterPath(filePath) {
  return path
    .resolve(filePath)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Generate a rich animated procedural demo clip via FFmpeg (zero API credits needed!).
 */
export async function createDemoClip({ outputPath, aspectRatio = '9:16', durationSec = 7, fps = 30, seed = 1, signal }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const { width, height } = getResolutionForAspect(aspectRatio);
  // Render at half-res first for blazing fast procedural gradient wave, then upscale smoothly
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  const palettes = [
    ['0x0f172a', '0x6366f1', '0xec4899'],
    ['0x064e3b', '0x10b981', '0x06b6d4'],
    ['0x1e1b4b', '0x8b5cf6', '0xf59e0b'],
    ['0x18181b', '0xf43f5e', '0xfb923c'],
    ['0x0c4a6e', '0x0284c7', '0x38bdf8']
  ];
  const pal = palettes[Math.abs(seed) % palettes.length];
  const dur = Math.max(3, Math.min(30, Number(durationSec) || 7));

  // Fast vibrant moving gradients source supported in FFmpeg 7+/9
  const filter = `gradients=s=${w}x${h}:r=${fps}:d=${dur}:c0=${pal[0]}:c1=${pal[1]}:c2=${pal[2]}:nb_colors=3:speed=0.025:type=radial,scale=${width}:${height}:flags=lanczos,format=yuv420p`;

  try {
    await runProcess(
      FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        filter,
        '-t',
        String(dur),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        outputPath
      ],
      { signal }
    );
  } catch {
    // Ultra-compatible fallback if gradients filter parameters differ
    await runProcess(
      FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${pal[1]}:s=${width}x${height}:r=${fps}:d=${dur}`,
        '-t',
        String(dur),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        outputPath
      ],
      { signal }
    );
  }
  return outputPath;
}

/**
 * Create a smooth Ken Burns slideshow video from 1+ local images with xfade transitions.
 */
export async function createSlideshowFromImages({
  imagePaths,
  outputPath,
  aspectRatio = '9:16',
  totalDurationSec = 8,
  fps = 30,
  transition = 'fade',
  transitionDuration = 0.5,
  fitMode = 'crop',
  signal
}) {
  if (!imagePaths || imagePaths.length === 0) {
    throw new Error('Không có ảnh đầu vào cho chế độ Slideshow.');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const { width, height } = getResolutionForAspect(aspectRatio);
  const count = imagePaths.length;
  const xfadeDur = count > 1 ? Math.min(1.0, Math.max(0.2, Number(transitionDuration) || 0.5)) : 0;
  const totalDur = Math.max(4, Number(totalDurationSec) || 8);
  const segDur = Math.max(2.0, (totalDur + xfadeDur * (count - 1)) / count);
  const framesPerSeg = Math.max(30, Math.round(segDur * fps));

  const tempDir = path.dirname(outputPath);
  const segmentFiles = [];

  for (let i = 0; i < count; i++) {
    const segFile = path.join(tempDir, `slide_seg_${i}.mp4`);
    // Alternate gentle zoom-in and zoom-out Ken Burns effect
    const zoomExpr =
      i % 2 === 0
        ? `min(zoom+0.0012,1.16)`
        : `if(lte(on,1),1.16,max(1.0,zoom-0.0012))`;

    const preScale =
      fitMode === 'blur'
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
        : `scale=${Math.round(width * 1.2)}:${Math.round(height * 1.2)}:force_original_aspect_ratio=increase,crop=${Math.round(width * 1.2)}:${Math.round(height * 1.2)}`;

    const vf = `${preScale},zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${framesPerSeg}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;

    await runProcess(
      FFMPEG_PATH,
      [
        '-y',
        '-loop',
        '1',
        '-i',
        imagePaths[i],
        '-vf',
        vf,
        '-t',
        segDur.toFixed(3),
        '-r',
        String(fps),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        segFile
      ],
      { signal }
    );
    segmentFiles.push(segFile);
  }

  if (segmentFiles.length === 1) {
    fs.copyFileSync(segmentFiles[0], outputPath);
    return outputPath;
  }

  return concatClipsWithTransitions({
    clipPaths: segmentFiles,
    outputPath,
    aspectRatio,
    fps,
    transition,
    transitionDuration: xfadeDur,
    fitMode,
    signal
  });
}

const VALID_XFADES = new Set([
  'fade',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'circleopen',
  'circleclose',
  'dissolve',
  'smoothleft',
  'smoothright',
  'zoomin',
  'radial',
  'fadeblack',
  'fadewhite'
]);

/**
 * Stitch multiple video clips together with normalized resolution/fps and smooth xfade transitions.
 */
export async function concatClipsWithTransitions({
  clipPaths,
  outputPath,
  aspectRatio = '9:16',
  fps = 30,
  transition = 'fade',
  transitionDuration = 0.5,
  fitMode = 'crop',
  signal
}) {
  if (!clipPaths || clipPaths.length === 0) {
    throw new Error('Không có clip nào để ghép.');
  }
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return outputPath;
  }

  const { width, height } = getResolutionForAspect(aspectRatio);
  const safeTransition = VALID_XFADES.has(transition) ? transition : 'fade';
  const transDur = Math.max(0.2, Math.min(1.5, Number(transitionDuration) || 0.5));

  // Probe durations & audio presence of each clip
  const metas = [];
  for (const cp of clipPaths) {
    metas.push(await probeMedia(cp));
  }

  const allHaveAudio = metas.every((m) => m.hasAudio);
  const args = ['-y'];
  for (const cp of clipPaths) {
    args.push('-i', cp);
  }

  const filterParts = [];
  for (let i = 0; i < clipPaths.length; i++) {
    const scaleFilter = buildReframeFilter(width, height, fitMode, fps);
    filterParts.push(`[${i}:v]${scaleFilter},settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
    if (allHaveAudio) {
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
    }
  }

  // Chain xfade video filters (and acrossfade audio if all have audio)
  let currentVideo = '[v0]';
  let currentAudio = '[a0]';
  let cumulativeDuration = Math.max(0.5, metas[0].duration);

  for (let i = 1; i < clipPaths.length; i++) {
    const clipDur = Math.max(0.5, metas[i].duration);
    const effectiveTrans = Math.min(transDur, cumulativeDuration * 0.4, clipDur * 0.4);
    const offset = Math.max(0, cumulativeDuration - effectiveTrans);
    const nextVideo = i === clipPaths.length - 1 ? '[vout]' : `[vx${i}]`;

    filterParts.push(
      `${currentVideo}[v${i}]xfade=transition=${safeTransition}:duration=${effectiveTrans.toFixed(3)}:offset=${offset.toFixed(3)}${nextVideo}`
    );

    if (allHaveAudio) {
      const nextAudio = i === clipPaths.length - 1 ? '[aout]' : `[ax${i}]`;
      filterParts.push(
        `${currentAudio}[a${i}]acrossfade=d=${effectiveTrans.toFixed(3)}:c1=tri:c2=tri${nextAudio}`
      );
      currentAudio = nextAudio;
    }

    currentVideo = nextVideo;
    cumulativeDuration = offset + clipDur;
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]');
  if (allHaveAudio) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    outputPath
  );

  await runProcess(FFMPEG_PATH, args, { signal });
  return outputPath;
}

function buildReframeFilter(width, height, fitMode, fps) {
  if (fitMode === 'blur') {
    // Handled as split graph in composeFinalVideo; fallback pad here for single chain
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1,format=yuv420p`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p`;
}

/**
 * Extract a fast crisp preview frame JPG from any intermediate or finished video clip.
 */
export async function extractPreviewFrame(videoPath, outputJpgPath, { timeSec = 0.8, signal } = {}) {
  try {
    fs.mkdirSync(path.dirname(outputJpgPath), { recursive: true });
    await runProcess(
      FFMPEG_PATH,
      [
        '-y',
        '-ss',
        String(Math.max(0, Number(timeSec) || 0).toFixed(2)),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-vf',
        'scale=480:-2',
        '-q:v',
        '5',
        outputJpgPath
      ],
      { signal }
    );
    return fs.existsSync(outputJpgPath) ? outputJpgPath : null;
  } catch {
    // Retry at t=0 if clip shorter than timeSec
    try {
      await runProcess(
        FFMPEG_PATH,
        ['-y', '-i', videoPath, '-vframes', '1', '-vf', 'scale=480:-2', '-q:v', '5', outputJpgPath],
        { signal }
      );
      return fs.existsSync(outputJpgPath) ? outputJpgPath : null;
    } catch {
      return null;
    }
  }
}

function parseFfmpegTimeSec(line) {
  const m = /time=(\d{2}):(\d{2}):(\d{2}\.\d+)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseFfmpegSpeed(line) {
  const m = /speed=\s*([\d.]+x)/.exec(line);
  return m ? m[1] : null;
}

/**
 * Master FFmpeg post-production composer:
 * - Reframe to 9:16 / 16:9 / 1:1 (crop-fill or blurred-background)
 * - Sync video duration to voiceover duration (seamless loop if shorter, trim if longer)
 * - Burn ASS subtitles + Title Hook banner
 * - Overlay PNG logo/watermark with corner position & opacity
 * - Mix Voiceover + Background Music (looped + fade in/out + ducked) + Optional Original Audio
 */
export async function composeFinalVideo({
  videoPath,
  voicePath = null,
  assPath = null,
  bgmPath = null,
  logoPath = null,
  outputPath,
  thumbnailPath = null,
  aspectRatio = '9:16',
  fitMode = 'crop',
  fps = 30,
  audioConfig = {},
  watermarkConfig = {},
  targetDurationSec = null,
  onProgress = null,
  signal
}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const { width, height } = getResolutionForAspect(aspectRatio);

  const videoMeta = await probeMedia(videoPath);
  const voiceMeta = voicePath && fs.existsSync(voicePath) ? await probeMedia(voicePath) : null;
  const hasVoice = Boolean(voiceMeta && voiceMeta.duration > 0.1);
  const hasBgm = Boolean(bgmPath && fs.existsSync(bgmPath));
  const hasLogo = Boolean(watermarkConfig.enabled && logoPath && fs.existsSync(logoPath));
  const hasAss = Boolean(assPath && fs.existsSync(assPath));
  const keepOriginal = Boolean(audioConfig.keepOriginalAudio && videoMeta.hasAudio);

  // Final output duration
  let finalDuration = videoMeta.duration || 8;
  if (hasVoice) {
    finalDuration = Math.max(2, voiceMeta.duration + 0.45);
  } else if (targetDurationSec && Number(targetDurationSec) > 0) {
    finalDuration = Number(targetDurationSec);
  }

  const needsLoop = videoMeta.duration > 0 && videoMeta.duration < finalDuration - 0.1;

  const args = ['-y'];
  let inputIdx = 0;

  // Input 0: Video
  if (needsLoop) {
    args.push('-stream_loop', '-1');
  }
  args.push('-i', videoPath);
  const videoIdx = inputIdx++;

  // Optional Input: Voiceover
  let voiceIdx = -1;
  if (hasVoice) {
    args.push('-i', voicePath);
    voiceIdx = inputIdx++;
  }

  // Optional Input: Background Music (looped infinitely, trimmed to finalDuration)
  let bgmIdx = -1;
  if (hasBgm) {
    args.push('-stream_loop', '-1', '-i', bgmPath);
    bgmIdx = inputIdx++;
  }

  // Optional Input: Watermark Logo PNG
  let logoIdx = -1;
  if (hasLogo) {
    args.push('-i', logoPath);
    logoIdx = inputIdx++;
  }

  const filterParts = [];
  let vLabel;

  // Step 1: Video reframe (Crop Fill OR Blurred Background Fit)
  if (fitMode === 'blur') {
    filterParts.push(
      `[${videoIdx}:v]split=2[bg_raw][fg_raw]`,
      `[bg_raw]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:6,fps=${fps},setsar=1[bg]`,
      `[fg_raw]scale=${width}:${height}:force_original_aspect_ratio=decrease,fps=${fps},setsar=1[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v_base]`
    );
    vLabel = '[v_base]';
  } else {
    filterParts.push(
      `[${videoIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p[v_base]`
    );
    vLabel = '[v_base]';
  }

  // Step 2: Watermark Overlay (before subtitles so subtitles stay legible on top, or corner-safe)
  if (hasLogo) {
    const scalePct = Math.max(5, Math.min(45, Number(watermarkConfig.scalePercent) || 16));
    const logoWidth = Math.max(48, Math.round((width * scalePct) / 100));
    const opacity = Math.max(0.1, Math.min(1.0, Number(watermarkConfig.opacity) ?? 0.85));
    const margin = Math.max(8, Math.min(180, Number(watermarkConfig.marginPx) || 32));

    let overlayCoords = `W-w-${margin}:${margin}`; // top-right
    switch (watermarkConfig.position) {
      case 'top-left':
        overlayCoords = `${margin}:${margin}`;
        break;
      case 'bottom-left':
        overlayCoords = `${margin}:H-h-${margin}`;
        break;
      case 'bottom-right':
        overlayCoords = `W-w-${margin}:H-h-${margin}`;
        break;
      default:
        overlayCoords = `W-w-${margin}:${margin}`;
    }

    filterParts.push(
      `[${logoIdx}:v]scale=${logoWidth}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(2)}[wm]`,
      `${vLabel}[wm]overlay=${overlayCoords}[v_wm]`
    );
    vLabel = '[v_wm]';
  }

  // Step 3: Burn ASS Subtitles & Hook Title Banner
  if (hasAss) {
    const escapedAss = escapeFilterPath(assPath);
    filterParts.push(`${vLabel}ass='${escapedAss}'[v_sub]`);
    vLabel = '[v_sub]';
  }

  // Final video label trim
  filterParts.push(`${vLabel}trim=duration=${finalDuration.toFixed(3)},setpts=PTS-STARTPTS[vout]`);

  // Step 4: Audio Mixing
  const audioSources = [];
  const voiceVol = Math.max(0.1, Math.min(2.5, Number(audioConfig.voiceVolume) ?? 1.0));
  const bgmVol = Math.max(0.02, Math.min(1.0, Number(audioConfig.bgmVolume) ?? 0.16));
  const origVol = Math.max(0.05, Math.min(1.5, Number(audioConfig.originalVolume) ?? 0.3));
  const fadeOutStart = Math.max(0, finalDuration - 1.4);

  if (hasVoice) {
    filterParts.push(
      `[${voiceIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,volume=${voiceVol.toFixed(2)},apad=whole_dur=${finalDuration.toFixed(3)},atrim=0:${finalDuration.toFixed(3)}[a_voice]`
    );
    audioSources.push('[a_voice]');
  }

  if (hasBgm) {
    filterParts.push(
      `[${bgmIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim=0:${finalDuration.toFixed(3)},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=1.4,volume=${bgmVol.toFixed(2)}[a_bgm]`
    );
    audioSources.push('[a_bgm]');
  }

  if (keepOriginal) {
    filterParts.push(
      `[${videoIdx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,atrim=0:${finalDuration.toFixed(3)},volume=${origVol.toFixed(2)}[a_orig]`
    );
    audioSources.push('[a_orig]');
  }

  let hasFinalAudio = false;
  if (audioSources.length === 1) {
    filterParts.push(`${audioSources[0]}anull[aout]`);
    hasFinalAudio = true;
  } else if (audioSources.length > 1) {
    filterParts.push(
      `${audioSources.join('')}amix=inputs=${audioSources.length}:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]`
    );
    hasFinalAudio = true;
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]');

  if (hasFinalAudio) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
  } else {
    args.push('-an');
  }

  args.push(
    '-t',
    finalDuration.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outputPath
  );

  let lastEmitTs = 0;
  await runProcess(FFMPEG_PATH, args, {
    signal,
    onStderr: (chunk) => {
      if (!onProgress || !finalDuration) return;
      const t = parseFfmpegTimeSec(chunk);
      if (t !== null) {
        const now = Date.now();
        if (now - lastEmitTs >= 320) {
          lastEmitTs = now;
          const ratio = Math.max(0, Math.min(1, t / finalDuration));
          onProgress({ ratio, timeSec: t, totalSec: finalDuration, speed: parseFfmpegSpeed(chunk) });
        }
      }
    }
  });

  // Extract crisp thumbnail frame
  if (thumbnailPath) {
    try {
      const thumbTime = Math.min(1.5, finalDuration * 0.25);
      await runProcess(
        FFMPEG_PATH,
        [
          '-y',
          '-ss',
          thumbTime.toFixed(2),
          '-i',
          outputPath,
          '-vframes',
          '1',
          '-vf',
          'scale=480:-1',
          '-q:v',
          '4',
          thumbnailPath
        ],
        { signal }
      );
    } catch {
      // thumbnail is optional
    }
  }

  return {
    outputPath,
    thumbnailPath: thumbnailPath && fs.existsSync(thumbnailPath) ? thumbnailPath : null,
    durationSec: Number(finalDuration.toFixed(2))
  };
}
