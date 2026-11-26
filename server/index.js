import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { parse as parseCsv } from 'csv-parse/sync';
import XLSX from 'xlsx';
import {
  FFMPEG_PATH,
  FFPROBE_PATH,
  MUSE_PRESETS,
  OUTPUTS_DIR,
  ROOT_DIR,
  TEMP_DIR,
  UPLOADS_DIR,
  VIETNAMESE_VOICES,
  loadSettings,
  sanitizeSettingsForClient,
  saveSettings
} from './config.js';
import { BatchQueueManager } from './batchQueue.js';
import { generateBatchIdeasWithAI, testMuseConnection } from './museClient.js';
import { synthesizeVoiceover } from './ttsEngine.js';

const PORT = Number(process.env.PORT) || 3456;
const app = express();
const queue = new BatchQueueManager();

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static assets & media previews
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// Multer storage for persistent uploads (BGM, Watermark, Reference Images, Local Media)
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const base = path
      .basename(file.originalname, ext)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 36);
    cb(null, `${Date.now()}_${base || 'file'}${ext.toLowerCase()}`);
  }
});
const uploadAsset = multer({ storage: diskStorage, limits: { fileSize: 300 * 1024 * 1024 } });
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// --- Bootstrap & Settings ---
app.get('/api/bootstrap', (_req, res) => {
  const settings = loadSettings();
  res.json({
    settings: sanitizeSettingsForClient(settings),
    presets: Object.values(MUSE_PRESETS),
    voices: VIETNAMESE_VOICES,
    queue: queue.getState(),
    system: {
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      outputsDir: OUTPUTS_DIR,
      port: PORT
    }
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const incoming = structuredClone(req.body || {});
    const current = loadSettings();

    // Preserve stored keys if frontend sends blank or masked placeholder
    if (incoming.muse) {
      if (incoming.muse.clearApiKey) {
        incoming.muse.apiKey = '';
      } else if (!incoming.muse.apiKey || incoming.muse.apiKey.includes('••••')) {
        incoming.muse.apiKey = current.muse.apiKey;
      }
      delete incoming.muse.clearApiKey;
      delete incoming.muse.hasApiKey;
      delete incoming.muse.apiKeyMasked;
    }

    if (incoming.scriptAi) {
      if (incoming.scriptAi.clearApiKey) {
        incoming.scriptAi.apiKey = '';
      } else if (!incoming.scriptAi.apiKey || incoming.scriptAi.apiKey.includes('••••')) {
        incoming.scriptAi.apiKey = current.scriptAi.apiKey;
      }
      delete incoming.scriptAi.clearApiKey;
      delete incoming.scriptAi.hasApiKey;
      delete incoming.scriptAi.apiKeyMasked;
    }

    const updated = saveSettings(incoming);
    res.json({ ok: true, settings: sanitizeSettingsForClient(updated) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Muse API Test Connection & Models ---
app.post('/api/muse/test', async (req, res) => {
  try {
    const current = loadSettings();
    const override = req.body || {};
    const museCfg = {
      ...current.muse,
      ...override,
      apiKey:
        override.apiKey && !override.apiKey.includes('••••')
          ? override.apiKey
          : current.muse.apiKey
    };
    const result = await testMuseConnection(museCfg);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// --- AI Batch Ideas / Script Generator ---
app.post('/api/ai/generate-ideas', async (req, res) => {
  try {
    const current = loadSettings();
    const { topic, count = 5, language = 'Tiếng Việt', style = 'cinematic viral TikTok', scriptAiOverride } = req.body || {};
    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ ok: false, error: 'Hãy nhập chủ đề để AI tạo kịch bản hàng loạt.' });
    }

    const cfg = {
      ...current.scriptAi,
      ...(scriptAiOverride || {}),
      apiKey:
        scriptAiOverride?.apiKey && !scriptAiOverride.apiKey.includes('••••')
          ? scriptAiOverride.apiKey
          : current.scriptAi.apiKey || current.muse.apiKey
    };

    const ideas = await generateBatchIdeasWithAI({
      scriptAiCfg: cfg,
      topic: String(topic).trim(),
      count: Math.max(1, Math.min(30, Number(count) || 5)),
      language,
      style
    });

    const added = queue.addJobs(ideas);
    res.json({ ok: true, addedCount: added.length, jobs: added });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Edge-TTS Live Voice Preview ---
app.post('/api/tts/preview', async (req, res) => {
  const { text, voice, rate, pitch } = req.body || {};
  const sampleText =
    String(text || '').trim() ||
    'Xin chào! Đây là giọng đọc AI tiếng Việt tự nhiên từ MuseBatch Studio, sẵn sàng tạo hàng loạt video chuyên nghiệp.';
  const tempFile = path.join(TEMP_DIR, `tts_preview_${Date.now()}.mp3`);
  try {
    await synthesizeVoiceover({
      text: sampleText,
      voice: voice || 'vi-VN-HoaiMyNeural',
      rate: rate || '+5%',
      pitch: pitch || '+0Hz',
      outputPath: tempFile
    });
    const audioBuf = fs.readFileSync(tempFile);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audioBuf);
  } catch (err) {
    res.status(500).json({ ok: false, error: `Lỗi Edge-TTS: ${err.message}` });
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
});

// --- Asset Uploads (BGM, Logo, Reference Images, Local Media) ---
app.post('/api/upload/asset', uploadAsset.array('files', 30), (req, res) => {
  const files = (req.files || []).map((f) => ({
    filename: f.filename,
    originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    url: `/uploads/${f.filename}`,
    size: f.size,
    mimetype: f.mimetype
  }));
  res.json({ ok: true, files });
});

// --- Jobs CRUD ---
app.get('/api/jobs', (_req, res) => {
  res.json(queue.getState());
});

app.post('/api/jobs', (req, res) => {
  const items = Array.isArray(req.body?.jobs) ? req.body.jobs : [req.body];
  if (!items.length) return res.status(400).json({ ok: false, error: 'Danh sách job trống.' });
  const added = queue.addJobs(items);
  res.json({ ok: true, added, state: queue.getState() });
});

app.put('/api/jobs/:id', (req, res) => {
  try {
    const updated = queue.updateJob(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'Không tìm thấy job.' });
    res.json({ ok: true, job: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/jobs/:id', (req, res) => {
  const ok = queue.deleteJob(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'Không tìm thấy job.' });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const job = queue.retryJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Không tìm thấy job.' });
  res.json({ ok: true, job });
});

// --- Batch Import (CSV / Excel / TXT) ---
function normalizeRowKeys(row) {
  const map = {};
  for (const [k, v] of Object.entries(row || {})) {
    const norm = String(k)
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_');
    map[norm] = v === undefined || v === null ? '' : String(v).trim();
  }
  const pick = (...keys) => {
    for (const k of keys) {
      if (map[k]) return map[k];
    }
    return '';
  };

  return {
    title: pick('title', 'tieu_de', 'ten', 'name', 'video_title'),
    hookText: pick('hooktext', 'hook_text', 'hook', 'banner', 'tieu_de_noi'),
    prompt: pick('prompt', 'visual_prompt', 'mo_ta', 'mo_ta_hinh_anh', 'canh', 'scene_prompt', 'prompts'),
    script: pick('script', 'voiceover', 'loi_thoai', 'kich_ban', 'narration', 'subtitle', 'phu_de', 'text'),
    aspectRatio: pick('aspectratio', 'aspect_ratio', 'ty_le', 'ratio'),
    duration: pick('duration', 'thoi_luong', 'seconds'),
    voice: pick('voice', 'giong_doc'),
    referenceImage: pick('referenceimage', 'reference_image', 'image_url', 'anh_mau'),
    sourceMode: pick('sourcemode', 'source_mode', 'che_do')
  };
}

app.post('/api/jobs/import', uploadMemory.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Chưa chọn file để nhập.' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let parsedItems = [];

    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      parsedItems = rows.map(normalizeRowKeys).filter((r) => r.prompt || r.script || r.title);
    } else if (ext === '.csv') {
      const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
      const rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
      parsedItems = rows.map(normalizeRowKeys).filter((r) => r.prompt || r.script || r.title);
    } else {
      // Plain .txt: each non-empty line is either "Title | Prompt | Script" or just Prompt
      const lines = req.file.buffer
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      parsedItems = lines.map((line, idx) => {
        const parts = line.split(';;').map((p) => p.trim());
        if (parts.length >= 3) {
          return { title: parts[0], prompt: parts[1], script: parts[2], hookText: parts[3] || parts[0] };
        }
        if (parts.length === 2) {
          return { title: `Video ${idx + 1}`, prompt: parts[0], script: parts[1] };
        }
        return { title: `Video ${idx + 1}`, prompt: line, script: '' };
      });
    }

    if (parsedItems.length === 0) {
      return res.status(400).json({ ok: false, error: 'Không tìm thấy dữ liệu hợp lệ trong file.' });
    }

    const added = queue.addJobs(parsedItems);
    res.json({ ok: true, addedCount: added.length, state: queue.getState() });
  } catch (err) {
    res.status(400).json({ ok: false, error: `Lỗi đọc file nhập hàng loạt: ${err.message}` });
  }
});

// --- Sample CSV Template Download ---
app.get('/api/template.csv', (_req, res) => {
  const csv = [
    'title,hookText,prompt,script,aspectRatio,duration',
    '"Bí mật giấc ngủ sâu","BÍ MẬT NGỦ NGON TRONG 5 PHÚT","Cinematic glowing bedroom at midnight, soft rain outside window, warm ambient moonlight, ultra realistic 4k | Slow motion steaming herbal tea cup on wooden table, cozy aesthetic","Bạn có biết chỉ cần thay đổi nhiệt độ phòng và tắt ánh sáng xanh ba mươi phút trước khi ngủ, chất lượng giấc ngủ sẽ tăng gấp đôi ngay tối nay!","9:16","8"',
    '"Cà phê sáng Sài Gòn","MỘT LY CÀ PHÊ ĐỔI CẢ NGÀY DÀI","Drone cinematic sunrise over Ho Chi Minh City streets, golden hour warm mist, energetic urban vibe | Close-up Vietnamese iced coffee dripping into condensed milk glass, cinematic macro lighting","Sài Gòn thức dậy cùng mùi thơm cà phê sữa đá đậm đà. Một khoảnh khắc nhỏ mỗi sáng nhưng đủ nạp đầy năng lượng cho cả ngày bứt phá!","9:16","8"',
    '"Tương lai AI 2026","CÔNG NGHỆ ĐANG THAY ĐỔI MỌI THỨ","Futuristic neon studio with holographic screens floating in air, sleek cyberpunk aesthetic, smooth camera orbit","Trí tuệ nhân tạo không thay thế bạn, nhưng người biết tận dụng công cụ tự động hóa hàng loạt chắc chắn sẽ đi nhanh gấp mười lần đối thủ!","9:16","8"'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="musebatch_template.csv"');
  res.send('\uFEFF' + csv);
});

// --- Queue Controls ---
app.post('/api/queue/start', (_req, res) => res.json({ ok: true, state: queue.start() }));
app.post('/api/queue/pause', (_req, res) => res.json({ ok: true, state: queue.pause() }));
app.post('/api/queue/resume', (_req, res) => res.json({ ok: true, state: queue.resume() }));
app.post('/api/queue/stop', (_req, res) => res.json({ ok: true, state: queue.stop() }));
app.post('/api/queue/retry-failed', (_req, res) => {
  queue.resetAllPending();
  res.json({ ok: true, state: queue.start() });
});
app.post('/api/queue/clear-completed', (_req, res) => {
  queue.clearCompleted();
  res.json({ ok: true, state: queue.getState() });
});
app.post('/api/queue/clear-all', (_req, res) => {
  queue.clearAll();
  res.json({ ok: true, state: queue.getState() });
});

// --- Server-Sent Events (Real-time live updates) ---
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: 'init', payload: queue.getState(), ts: Date.now() });

  const onEvent = (evt) => send(evt);
  queue.on('event', onEvent);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    queue.off('event', onEvent);
  });
});

// --- Bulk ZIP Export of Completed Videos ---
app.get('/api/outputs/zip', (req, res) => {
  const completed = queue.jobs.filter((j) => j.status === 'completed' && j.outputFile);
  const existing = completed
    .map((j) => ({
      name: j.outputFile,
      fullPath: path.join(OUTPUTS_DIR, path.basename(j.outputFile))
    }))
    .filter((f) => fs.existsSync(f.fullPath));

  if (existing.length === 0) {
    return res.status(404).json({ ok: false, error: 'Chưa có video nào hoàn thành để tải ZIP.' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="musebatch_videos_${Date.now()}.zip"`);

  const archive = archiver('zip', { zlib: { level: 3 } });
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).end(err.message);
  });
  archive.pipe(res);
  for (const item of existing) {
    archive.file(item.fullPath, { name: item.name });
  }
  archive.finalize();
});

// --- Open Output Folder in Windows Explorer ---
app.post('/api/system/open-outputs', (_req, res) => {
  try {
    spawn('explorer.exe', [OUTPUTS_DIR], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true, path: OUTPUTS_DIR });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health endpoint
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ffmpeg: FFMPEG_PATH, ffprobe: FFPROBE_PATH });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n================================================`);
  console.log(`  MuseBatch Studio đang chạy tại:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  FFmpeg: ${FFMPEG_PATH}`);
  console.log(`  Output: ${OUTPUTS_DIR}`);
  console.log(`================================================\n`);
});
