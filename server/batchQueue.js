import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { JOBS_FILE, OUTPUTS_DIR, TEMP_DIR, UPLOADS_DIR, loadSettings } from './config.js';
import { generateMuseVideoClip } from './museClient.js';
import { synthesizeVoiceover } from './ttsEngine.js';
import { generateAssSubtitles } from './subtitleEngine.js';
import {
  composeFinalVideo,
  concatClipsWithTransitions,
  createDemoClip,
  createSlideshowFromImages,
  probeMedia
} from './ffmpegEngine.js';

function sanitizeFilename(name) {
  return String(name || 'video')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'video';
}

function resolveUploadPath(relOrAbs) {
  if (!relOrAbs) return null;
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  if (fs.existsSync(relOrAbs)) return relOrAbs;
  const candidate = path.join(UPLOADS_DIR, path.basename(relOrAbs));
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function isImageFile(filePath) {
  return /\.(png|jpe?g|webp|bmp|gif)$/i.test(filePath || '');
}

function isVideoFile(filePath) {
  return /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(filePath || '');
}

export class BatchQueueManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = this.loadJobs();
    this.isRunning = false;
    this.isPaused = false;
    this.activeControllers = new Map();
    this.activeCount = 0;

    // Reset any stale 'running' jobs left over from an unexpected process crash
    let dirty = false;
    for (const job of this.jobs) {
      if (job.status === 'running') {
        job.status = 'pending';
        job.step = 'Chờ chạy lại';
        job.progress = 0;
        dirty = true;
      }
    }
    if (dirty) this.saveJobs();
  }

  loadJobs() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.error('[queue] Failed to read jobs.json:', err.message);
    }
    return [];
  }

  saveJobs() {
    try {
      fs.writeFileSync(JOBS_FILE, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch (err) {
      console.error('[queue] Failed to write jobs.json:', err.message);
    }
  }

  emitUpdate(eventType, payload) {
    this.emit('event', { type: eventType, payload, ts: Date.now() });
  }

  getState() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      activeCount: this.activeCount,
      jobs: this.jobs
    };
  }

  addJobs(items) {
    const added = [];
    for (const raw of items) {
      const id = uuidv4().slice(0, 8);
      const job = {
        id,
        title: String(raw.title || `Video ${this.jobs.length + 1}`).trim(),
        hookText: String(raw.hookText || raw.hook || '').trim(),
        prompt: String(raw.prompt || '').trim(),
        script: String(raw.script || raw.voiceover || '').trim(),
        sourceMode: raw.sourceMode || '', // '' inherits global setting
        aspectRatio: raw.aspectRatio || '', // '' inherits global setting
        duration: raw.duration ? String(raw.duration) : '',
        voice: raw.voice || '',
        referenceImage: raw.referenceImage || '',
        mediaFiles: Array.isArray(raw.mediaFiles) ? raw.mediaFiles : [],
        status: 'pending', // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
        step: 'Đang chờ',
        progress: 0,
        logs: [],
        error: null,
        outputFile: null,
        thumbnailFile: null,
        durationSec: null,
        createdAt: new Date().toISOString(),
        completedAt: null
      };
      this.jobs.push(job);
      added.push(job);
    }
    this.saveJobs();
    this.emitUpdate('jobs_changed', this.getState());
    return added;
  }

  updateJob(id, patch) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (job.status === 'running') {
      throw new Error('Không thể sửa job đang chạy.');
    }
    const editable = [
      'title',
      'hookText',
      'prompt',
      'script',
      'sourceMode',
      'aspectRatio',
      'duration',
      'voice',
      'referenceImage',
      'mediaFiles'
    ];
    for (const key of editable) {
      if (patch[key] !== undefined) job[key] = patch[key];
    }
    this.saveJobs();
    this.emitUpdate('job_updated', job);
    return job;
  }

  deleteJob(id) {
    const idx = this.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    const ctrl = this.activeControllers.get(id);
    if (ctrl) ctrl.abort();
    const [removed] = this.jobs.splice(idx, 1);
    if (removed.outputFile) {
      const fullOut = path.join(OUTPUTS_DIR, path.basename(removed.outputFile));
      if (fs.existsSync(fullOut)) fs.rmSync(fullOut, { force: true });
    }
    if (removed.thumbnailFile) {
      const fullThumb = path.join(OUTPUTS_DIR, path.basename(removed.thumbnailFile));
      if (fs.existsSync(fullThumb)) fs.rmSync(fullThumb, { force: true });
    }
    this.saveJobs();
    this.emitUpdate('jobs_changed', this.getState());
    return true;
  }

  retryJob(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    if (job.status === 'running') return job;
    job.status = 'pending';
    job.step = 'Chờ chạy lại';
    job.progress = 0;
    job.error = null;
    this.saveJobs();
    this.emitUpdate('job_updated', job);
    if (this.isRunning && !this.isPaused) {
      this.pumpQueue();
    }
    return job;
  }

  resetAllPending() {
    for (const job of this.jobs) {
      if (job.status === 'failed' || job.status === 'cancelled') {
        job.status = 'pending';
        job.step = 'Chờ chạy lại';
        job.progress = 0;
        job.error = null;
      }
    }
    this.saveJobs();
    this.emitUpdate('jobs_changed', this.getState());
  }

  clearCompleted() {
    this.jobs = this.jobs.filter((j) => j.status !== 'completed');
    this.saveJobs();
    this.emitUpdate('jobs_changed', this.getState());
  }

  clearAll() {
    this.stop();
    this.jobs = [];
    this.saveJobs();
    this.emitUpdate('jobs_changed', this.getState());
  }

  start() {
    const hasPending = this.jobs.some((j) => j.status === 'pending');
    if (!hasPending) {
      return this.getState();
    }
    this.isRunning = true;
    this.isPaused = false;
    this.emitUpdate('queue_state', this.getState());
    this.pumpQueue();
    return this.getState();
  }

  pause() {
    this.isPaused = true;
    this.emitUpdate('queue_state', this.getState());
    return this.getState();
  }

  resume() {
    if (!this.isRunning) return this.start();
    this.isPaused = false;
    this.emitUpdate('queue_state', this.getState());
    this.pumpQueue();
    return this.getState();
  }

  stop() {
    this.isRunning = false;
    this.isPaused = false;
    for (const [, ctrl] of this.activeControllers) {
      ctrl.abort();
    }
    this.activeControllers.clear();
    this.emitUpdate('queue_state', this.getState());
    return this.getState();
  }

  pumpQueue() {
    if (!this.isRunning || this.isPaused) return;
    const settings = loadSettings();
    const concurrency = Math.max(1, Math.min(5, Number(settings.production?.concurrency) || 2));

    while (this.activeCount < concurrency) {
      const nextJob = this.jobs.find((j) => j.status === 'pending');
      if (!nextJob) break;
      this.launchJob(nextJob, settings);
    }

    if (this.activeCount === 0 && !this.jobs.some((j) => j.status === 'pending')) {
      this.isRunning = false;
      this.isPaused = false;
      this.emitUpdate('queue_state', this.getState());
    }
  }

  async launchJob(job, settingsSnapshot) {
    this.activeCount++;
    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);

    job.status = 'running';
    job.error = null;
    job.progress = 3;
    job.step = 'Khởi tạo pipeline...';
    job.logs = [];
    this.logJob(job, 'Bắt đầu xử lý video...');
    this.saveJobs();
    this.emitUpdate('job_updated', job);

    const maxRetries = Math.max(0, Math.min(3, Number(settingsSnapshot.production?.retries) || 0));
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        if (attempt > 1) {
          this.logJob(job, `Thử lại lần ${attempt}/${maxRetries + 1}...`);
        }
        await this.executeJobPipeline(job, settingsSnapshot, controller.signal);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (controller.signal.aborted) break;
        this.logJob(job, `Lỗi: ${err.message}`);
        if (attempt <= maxRetries) {
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    }

    this.activeControllers.delete(job.id);
    this.activeCount--;

    if (controller.signal.aborted) {
      job.status = 'cancelled';
      job.step = 'Đã hủy';
      job.error = 'Đã hủy bởi người dùng';
    } else if (lastError) {
      job.status = 'failed';
      job.step = 'Thất bại';
      job.error = lastError.message;
    } else {
      job.status = 'completed';
      job.step = 'Hoàn tất!';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    }

    this.saveJobs();
    this.emitUpdate('job_updated', job);
    this.pumpQueue();
  }

  logJob(job, msg, progress = null, step = null) {
    const stamp = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    job.logs.push(`[${stamp}] ${msg}`);
    if (job.logs.length > 80) job.logs.shift();
    if (progress !== null) job.progress = Math.min(99, Math.max(job.progress, progress));
    if (step !== null) job.step = step;
    this.emitUpdate('job_updated', job);
  }

  async executeJobPipeline(job, settings, signal) {
    const workDir = path.join(TEMP_DIR, `job_${job.id}_${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });

    try {
      const sourceMode = job.sourceMode || settings.production.sourceMode || 'muse';
      const aspectRatio = job.aspectRatio || settings.production.aspectRatio || '9:16';
      const fitMode = settings.production.fitMode || 'crop';
      const fps = Number(settings.production.fps) || 30;
      const transition = settings.production.transition || 'fade';
      const transitionDuration = Number(settings.production.transitionDuration) || 0.5;
      const targetDurSec = Number(job.duration || settings.muse.duration || 8);

      // 1. Voiceover TTS (done early so we know exact duration for slideshow / video sync!)
      let voiceResult = { audioPath: null, durationMs: 0, wordTimings: [] };
      const shouldTts = settings.tts?.enabled && job.script && job.script.trim().length > 0;

      if (shouldTts) {
        this.logJob(job, `Tạo giọng đọc AI (${job.voice || settings.tts.voice})...`, 12, 'Đang tạo giọng đọc Edge-TTS...');
        try {
          voiceResult = await synthesizeVoiceover({
            text: job.script,
            voice: job.voice || settings.tts.voice || 'vi-VN-HoaiMyNeural',
            rate: settings.tts.rate || '+5%',
            pitch: settings.tts.pitch || '+0Hz',
            outputPath: path.join(workDir, 'voice.mp3')
          });
          this.logJob(
            job,
            `Đã tạo giọng đọc (${(voiceResult.durationMs / 1000).toFixed(1)}s, ${voiceResult.wordTimings.length} từ có timestamp).`,
            25
          );
        } catch (ttsErr) {
          this.logJob(
            job,
            `Cảnh báo Edge-TTS lỗi (${ttsErr.message}). Tiếp tục render không có giọng đọc.`,
            25
          );
        }
      }

      if (signal.aborted) throw new Error('Đã hủy');

      // 2. Acquire base visual footage (Muse API / Local Media / Demo mode)
      const rawVideoPath = path.join(workDir, 'base_video.mp4');
      const desiredVisualSec = voiceResult.durationMs
        ? Math.max(4, voiceResult.durationMs / 1000 + 0.5)
        : targetDurSec;

      if (sourceMode === 'muse') {
        // Support multi-scene prompts separated by "|"
        const scenePrompts = (job.prompt || job.title || 'Cinematic futuristic neon city at night')
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);

        const refImage = resolveUploadPath(job.referenceImage);
        const generatedClips = [];

        for (let i = 0; i < scenePrompts.length; i++) {
          if (signal.aborted) throw new Error('Đã hủy');
          const clipOut = path.join(workDir, `muse_scene_${i}.mp4`);
          const basePct = 28 + Math.round((i / scenePrompts.length) * 42);
          this.logJob(
            job,
            `Muse API: Tạo cảnh ${i + 1}/${scenePrompts.length}...`,
            basePct,
            `Muse API đang tạo cảnh ${i + 1}/${scenePrompts.length}...`
          );

          await generateMuseVideoClip({
            museCfg: settings.muse,
            prompt: scenePrompts[i],
            aspectRatio,
            duration: job.duration || settings.muse.duration,
            resolution: settings.muse.resolution,
            referenceImage: i === 0 ? refImage : null,
            outputPath: clipOut,
            signal,
            onProgress: (msg) => this.logJob(job, msg)
          });

          generatedClips.push(clipOut);
        }

        if (generatedClips.length === 1) {
          fs.copyFileSync(generatedClips[0], rawVideoPath);
        } else {
          this.logJob(job, `Ghép ${generatedClips.length} cảnh với hiệu ứng chuyển cảnh (${transition})...`, 72, 'Đang ghép cảnh chuyển tiếp...');
          await concatClipsWithTransitions({
            clipPaths: generatedClips,
            outputPath: rawVideoPath,
            aspectRatio,
            fps,
            transition,
            transitionDuration,
            fitMode,
            signal
          });
        }
      } else if (sourceMode === 'local_media') {
        const resolvedFiles = (job.mediaFiles || []).map(resolveUploadPath).filter(Boolean);
        const refImg = resolveUploadPath(job.referenceImage);
        if (resolvedFiles.length === 0 && refImg) resolvedFiles.push(refImg);

        if (resolvedFiles.length === 0) {
          throw new Error('Chế độ Ảnh/Video có sẵn cần ít nhất 1 ảnh hoặc clip đính kèm cho dòng này!');
        }

        const images = resolvedFiles.filter(isImageFile);
        const videos = resolvedFiles.filter(isVideoFile);

        if (videos.length > 0 && images.length === 0) {
          this.logJob(job, `Ghép ${videos.length} video cục bộ (${transition})...`, 55, 'Đang ghép video cục bộ...');
          await concatClipsWithTransitions({
            clipPaths: videos,
            outputPath: rawVideoPath,
            aspectRatio,
            fps,
            transition,
            transitionDuration,
            fitMode,
            signal
          });
        } else {
          const allImgs = images.length > 0 ? images : resolvedFiles;
          this.logJob(
            job,
            `Tạo slideshow Ken Burns từ ${allImgs.length} ảnh (${transition})...`,
            55,
            'Đang dựng Slideshow Ken Burns...'
          );
          await createSlideshowFromImages({
            imagePaths: allImgs,
            outputPath: rawVideoPath,
            aspectRatio,
            totalDurationSec: desiredVisualSec,
            fps,
            transition,
            transitionDuration,
            fitMode,
            signal
          });
        }
      } else {
        // Demo / Offline test render mode
        this.logJob(job, `Chế độ Demo Render: Tạo nền động ${aspectRatio} (${desiredVisualSec.toFixed(1)}s)...`, 55, 'Đang tạo nền Demo FFmpeg...');
        const seed = parseInt(job.id.slice(0, 4), 16) || 1;
        await createDemoClip({
          outputPath: rawVideoPath,
          aspectRatio,
          durationSec: desiredVisualSec,
          fps,
          seed,
          signal
        });
      }

      if (signal.aborted) throw new Error('Đã hủy');

      // 3. Generate ASS subtitles & optional Title Hook banner
      const videoMeta = await probeMedia(rawVideoPath);
      const totalDurationMs = voiceResult.durationMs
        ? voiceResult.durationMs + 450
        : Math.max(3000, Math.round((videoMeta.duration || targetDurSec) * 1000));

      let assPath = null;
      const hasSubScript = settings.subtitles?.enabled && job.script && job.script.trim().length > 0;
      const hasHook = settings.subtitles?.showHookBanner && (job.hookText || job.title);

      if (hasSubScript || hasHook) {
        this.logJob(job, `Tạo file phụ đề ASS kiểu "${settings.subtitles?.style || 'tiktok'}"...`, 78, 'Đang tạo phụ đề tự động...');
        assPath = path.join(workDir, 'subtitles.ass');
        generateAssSubtitles({
          outputPath: assPath,
          wordTimings: voiceResult.wordTimings,
          scriptText: hasSubScript ? job.script : '',
          totalDurationMs,
          aspectRatio,
          subtitlesConfig: {
            ...settings.subtitles,
            enabled: Boolean(hasSubScript)
          },
          hookText: job.hookText || (settings.subtitles?.showHookBanner ? job.title : '')
        });
      }

      // 4. Final FFmpeg composition (Reframe + Subtitles + Logo Watermark + Voiceover + BGM)
      this.logJob(job, 'Hậu kỳ FFmpeg: Ghép âm thanh, nhạc nền, phụ đề & logo...', 85, 'Đang render video hoàn chỉnh...');

      const baseName = `${sanitizeFilename(job.title)}_${job.id}`;
      const finalFilename = `${baseName}.mp4`;
      const thumbFilename = `${baseName}.jpg`;
      const finalOutPath = path.join(OUTPUTS_DIR, finalFilename);
      const finalThumbPath = path.join(OUTPUTS_DIR, thumbFilename);

      const bgmPath = resolveUploadPath(settings.audio?.bgmFile);
      const logoPath = resolveUploadPath(settings.watermark?.logoFile);

      const composed = await composeFinalVideo({
        videoPath: rawVideoPath,
        voicePath: voiceResult.audioPath,
        assPath,
        bgmPath,
        logoPath,
        outputPath: finalOutPath,
        thumbnailPath: finalThumbPath,
        aspectRatio,
        fitMode,
        fps,
        audioConfig: settings.audio,
        watermarkConfig: settings.watermark,
        targetDurationSec: voiceResult.audioPath ? null : targetDurSec,
        signal
      });

      job.outputFile = finalFilename;
      job.thumbnailFile = composed.thumbnailPath ? thumbFilename : null;
      job.durationSec = composed.durationSec;
      this.logJob(job, `Hoàn tất! File xuất: ${finalFilename} (${composed.durationSec}s)`, 99, 'Hoàn tất');
    } finally {
      // Clean temporary workspace for this job
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}
