import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function joinUrl(base, endpoint) {
  const b = String(base || '').replace(/\/+$/, '');
  const e = String(endpoint || '').startsWith('/') ? endpoint : `/${endpoint}`;
  return `${b}${e}`;
}

function buildAuthHeaders(museCfg) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  if (museCfg.apiKey) {
    const headerName = museCfg.authHeader || 'Authorization';
    const prefix = museCfg.authPrefix ?? 'Bearer ';
    headers[headerName] = `${prefix}${museCfg.apiKey.trim()}`;
  }
  return headers;
}

/**
 * Convert a local image file to base64 data URL (used when passing reference image to Muse API).
 */
function imageToDataUrl(filePath) {
  if (!filePath) return null;
  if (/^https?:\/\//i.test(filePath) || /^data:image\//i.test(filePath)) {
    return filePath;
  }
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * Universal task ID extractor across MuseVideos, Muse-AI-Pro, OpenAI-style video gateways, etc.
 */
export function extractTaskId(json) {
  if (!json || typeof json !== 'object') return null;
  return (
    json.id ||
    json.task_id ||
    json.taskId ||
    json.job_id ||
    json.video_id ||
    json.uuid ||
    json.data?.task_id ||
    json.data?.taskId ||
    json.data?.id ||
    json.data?.job_id ||
    json.data?.img_uuid ||
    json.data?.video_id ||
    json.result?.id ||
    json.result?.task_id ||
    null
  );
}

/**
 * Universal status normalizer -> 'queued' | 'processing' | 'succeeded' | 'failed'
 */
export function extractStatus(json) {
  const raw = String(
    json?.status ||
      json?.state ||
      json?.data?.status ||
      json?.data?.state ||
      json?.task_status ||
      ''
  )
    .toLowerCase()
    .trim();

  if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished', 'ready'].includes(raw)) {
    return 'succeeded';
  }
  if (['failed', 'fail', 'error', 'cancelled', 'canceled', 'rejected', 'timeout'].includes(raw)) {
    return 'failed';
  }
  if (['queued', 'pending', 'submitted', 'created', 'waiting'].includes(raw)) {
    return 'queued';
  }
  return 'processing';
}

/**
 * Universal video URL extractor across all known Muse / video gateway response formats.
 */
export function extractVideoUrl(json) {
  if (!json || typeof json !== 'object') return null;

  const candidates = [
    json.video_url,
    json.url,
    json.download_url,
    Array.isArray(json.videos) ? (typeof json.videos[0] === 'string' ? json.videos[0] : json.videos[0]?.url) : null,
    json.output?.video_url,
    json.output?.url,
    Array.isArray(json.output) ? (typeof json.output[0] === 'string' ? json.output[0] : json.output[0]?.url) : null,
    json.data?.video_url,
    json.data?.url,
    Array.isArray(json.data?.videos)
      ? typeof json.data.videos[0] === 'string'
        ? json.data.videos[0]
        : json.data.videos[0]?.url
      : null,
    json.data?.response?.resultUrls?.[0],
    json.data?.resultUrls?.[0],
    json.data?.output?.video_url,
    json.data?.output?.url,
    json.response?.resultUrls?.[0],
    json.result?.video_url,
    json.result?.url,
    Array.isArray(json.result?.videos) ? json.result.videos[0]?.url || json.result.videos[0] : null
  ];

  for (const url of candidates) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return url;
    }
  }

  // Deep fallback scan for any .mp4 URL in JSON
  const found = deepFindMp4Url(json);
  return found || null;
}

function deepFindMp4Url(obj, depth = 0) {
  if (!obj || depth > 6) return null;
  if (typeof obj === 'string') {
    if (/^https?:\/\/.+\.(mp4|mov|webm)(\?.*)?$/i.test(obj)) return obj;
    return null;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = deepFindMp4Url(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      const hit = deepFindMp4Url(val, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function extractErrorMessage(json, fallbackText = '') {
  const err =
    json?.error?.message ||
    (typeof json?.error === 'string' ? json.error : null) ||
    json?.data?.error?.message ||
    (typeof json?.data?.error === 'string' ? json.data.error : null) ||
    json?.message ||
    json?.detail ||
    fallbackText;
  return err ? String(err).slice(0, 400) : 'Unknown API error';
}

function buildCreatePayload(museCfg, { prompt, aspectRatio, duration, resolution, referenceImage }) {
  const style = museCfg.payloadStyle || 'musevideos';
  const refUrl = imageToDataUrl(referenceImage);
  let extra = {};
  try {
    if (museCfg.extraPayloadJson && museCfg.extraPayloadJson.trim()) {
      extra = JSON.parse(museCfg.extraPayloadJson);
    }
  } catch {
    // ignore malformed extra JSON
  }

  const dur = duration || museCfg.duration || '8';
  const res = resolution || museCfg.resolution || '720p';

  let payload;
  if (style === 'openai_videos') {
    payload = {
      model: museCfg.model || 'muse-video',
      prompt,
      duration: Number(dur) || 8,
      size: aspectRatio || '9:16',
      generate_audio: Boolean(museCfg.generateAudio)
    };
    if (refUrl) payload.image_urls = [refUrl];
  } else if (style === 'muse_ai_pro') {
    payload = {
      model: museCfg.model || 'muse-video',
      prompt,
      duration: Number(dur) || 10,
      aspect_ratio: aspectRatio || '9:16',
      resolution: res
    };
    if (refUrl) payload.image_urls = [refUrl];
  } else {
    // musevideos.io standard payload
    payload = {
      model: museCfg.model || 'veo-3.1-fast',
      prompt,
      duration: String(dur),
      resolution: res,
      aspect_ratio: aspectRatio || '9:16'
    };
    if (refUrl) payload.image_url = refUrl;
  }

  return { ...payload, ...extra };
}

/**
 * Test connection & optionally fetch available models from the configured Muse API endpoint.
 */
export async function testMuseConnection(museCfg) {
  if (!museCfg.apiKey || !museCfg.apiKey.trim()) {
    return { ok: false, message: 'Chưa nhập Muse API Key.' };
  }
  const headers = buildAuthHeaders(museCfg);
  const modelsPath = museCfg.modelsPath?.trim();
  const testUrl = modelsPath ? joinUrl(museCfg.baseUrl, modelsPath) : museCfg.baseUrl;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(testUrl, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timer);

    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-json response
    }

    if (resp.ok) {
      const models = extractModelsList(json);
      return {
        ok: true,
        status: resp.status,
        message: models.length
          ? `Kết nối thành công! Tìm thấy ${models.length} model.`
          : `Kết nối thành công (HTTP ${resp.status}).`,
        models
      };
    }

    // 404 on /models might still mean auth works if provider doesn't expose /models
    if (resp.status === 404 && !modelsPath) {
      return { ok: true, status: resp.status, message: 'Server phản hồi (không có danh sách /models, hãy thử tạo 1 video).' };
    }

    return {
      ok: false,
      status: resp.status,
      message: `HTTP ${resp.status}: ${extractErrorMessage(json, text)}`
    };
  } catch (err) {
    return {
      ok: false,
      message: `Không kết nối được tới ${testUrl}: ${err.message}`
    };
  }
}

function extractModelsList(json) {
  if (!json) return [];
  const raw = Array.isArray(json)
    ? json
    : Array.isArray(json.models)
      ? json.models
      : Array.isArray(json.data)
        ? json.data
        : [];
  return raw
    .map((m) => {
      if (typeof m === 'string') return { id: m, name: m };
      const id = m.id || m.model || m.slug || m.name;
      if (!id) return null;
      return {
        id,
        name: m.name || id,
        description: m.description || m.provider || ''
      };
    })
    .filter(Boolean);
}

/**
 * Submit a video generation request to Muse API, poll until succeeded, and download MP4 to outputPath.
 */
export async function generateMuseVideoClip({
  museCfg,
  prompt,
  aspectRatio,
  duration,
  resolution,
  referenceImage,
  outputPath,
  onProgress,
  signal
}) {
  if (!museCfg.apiKey || !museCfg.apiKey.trim()) {
    throw new Error('Thiếu Muse API Key! Hãy vào mục Cài đặt API và dán API Key của bạn.');
  }

  const headers = buildAuthHeaders(museCfg);
  const createUrl = joinUrl(museCfg.baseUrl, museCfg.createPath || '/videos');
  const payload = buildCreatePayload(museCfg, {
    prompt,
    aspectRatio,
    duration,
    resolution,
    referenceImage
  });

  onProgress?.(`Gửi yêu cầu tạo video tới ${createUrl} (model: ${payload.model})...`);

  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal
  });

  const createText = await createRes.text();
  let createJson = null;
  try {
    createJson = JSON.parse(createText);
  } catch {
    // ignore
  }

  if (!createRes.ok) {
    throw new Error(`Muse API lỗi (HTTP ${createRes.status}): ${extractErrorMessage(createJson, createText)}`);
  }

  // Some synchronous endpoints might return video URL immediately
  let videoUrl = extractVideoUrl(createJson);
  const taskId = extractTaskId(createJson);

  if (!videoUrl && !taskId) {
    throw new Error(
      `Muse API không trả về task_id hoặc link video. Phản hồi: ${createText.slice(0, 300)}`
    );
  }

  if (!videoUrl && taskId) {
    onProgress?.(`Đã tạo task ${taskId}. Đang chờ AI render video...`);
    const pollIntervalMs = Math.max(2, Number(museCfg.pollIntervalSec) || 5) * 1000;
    const maxWaitMs = Math.max(30, Number(museCfg.maxWaitSec) || 420) * 1000;
    const deadline = Date.now() + maxWaitMs;
    const statusTemplate = museCfg.statusPath || '/videos/{id}';
    const statusUrl = joinUrl(museCfg.baseUrl, statusTemplate.replace('{id}', encodeURIComponent(taskId)));

    let attempt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Đã hủy theo yêu cầu người dùng.');
      await sleep(pollIntervalMs, signal);
      attempt++;

      const pollRes = await fetch(statusUrl, { method: 'GET', headers, signal });
      const pollText = await pollRes.text();
      let pollJson = null;
      try {
        pollJson = JSON.parse(pollText);
      } catch {
        // ignore
      }

      if (!pollRes.ok) {
        if (pollRes.status >= 500) {
          onProgress?.(`Server tạm lỗi ${pollRes.status}, thử kiểm tra lại...`);
          continue;
        }
        throw new Error(`Lỗi kiểm tra tiến độ (HTTP ${pollRes.status}): ${extractErrorMessage(pollJson, pollText)}`);
      }

      const status = extractStatus(pollJson);
      const pct = pollJson?.progress ?? pollJson?.data?.progress;
      const pctStr = pct !== undefined && pct !== null ? ` (${pct}%)` : '';
      onProgress?.(`Task ${taskId}: ${status}${pctStr} [lần kiểm tra #${attempt}]`);

      if (status === 'succeeded') {
        videoUrl = extractVideoUrl(pollJson);
        if (!videoUrl) {
          throw new Error(`Task báo hoàn thành nhưng không tìm thấy link MP4: ${pollText.slice(0, 300)}`);
        }
        break;
      }

      if (status === 'failed') {
        throw new Error(`Muse API render thất bại: ${extractErrorMessage(pollJson, pollText)}`);
      }
    }

    if (!videoUrl) {
      throw new Error(`Hết thời gian chờ (${museCfg.maxWaitSec || 420}s) cho task ${taskId}.`);
    }
  }

  // Download MP4 locally
  onProgress?.(`Đang tải video AI từ CDN về máy...`);
  await downloadFile(videoUrl, outputPath, signal);
  return { taskId, videoUrl, outputPath };
}

async function downloadFile(url, outputPath, signal) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`Không tải được video từ ${url} (HTTP ${res.status})`);
  }
  const writeStream = fs.createWriteStream(outputPath);
  await pipeline(Readable.fromWeb(res.body), writeStream);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Đã hủy bởi người dùng.'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Optional AI Batch Script & Prompt Generator using any OpenAI-compatible chat endpoint
 * (Meta Model API https://api.meta.ai/v1, OpenAI, OpenRouter, etc.)
 */
export async function generateBatchIdeasWithAI({ scriptAiCfg, topic, count = 5, language = 'Tiếng Việt', style = 'cinematic viral TikTok' }) {
  const apiKey = scriptAiCfg?.apiKey?.trim();
  if (!apiKey) {
    throw new Error('Chưa cấu hình API Key cho bộ tạo kịch bản AI (AI Script Generator).');
  }

  const url = joinUrl(scriptAiCfg.baseUrl || 'https://api.meta.ai/v1', '/chat/completions');
  const systemPrompt = `You are a viral short-video producer. Generate exactly ${count} unique video ideas for batch AI video creation.
Return ONLY valid JSON array with no markdown fences, where each item has:
- "title": short catchy title (${language})
- "hookText": punchy 4-8 word hook banner text (${language})
- "prompt": rich English visual prompt for AI video generator (describe camera motion, lighting, subject, mood, style: ${style})
- "script": engaging 15-30 word voiceover narration (${language})`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: scriptAiCfg.model || 'muse-wonder-1.0',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Topic: ${topic}\nNumber of videos: ${count}` }
      ],
      temperature: 0.85
    })
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // ignore
  }
  if (!res.ok) {
    throw new Error(`AI Script API lỗi (${res.status}): ${extractErrorMessage(json, text)}`);
  }

  const content = json?.choices?.[0]?.message?.content || '';
  const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('AI không trả về mảng JSON hợp lệ.');
  }
  return parsed.map((item, idx) => ({
    title: String(item.title || `Video ${idx + 1}`),
    hookText: String(item.hookText || item.title || ''),
    prompt: String(item.prompt || ''),
    script: String(item.script || '')
  }));
}
