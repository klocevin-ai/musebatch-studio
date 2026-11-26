import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const OUTPUTS_DIR = path.join(DATA_DIR, 'outputs');
export const PREVIEWS_DIR = path.join(DATA_DIR, 'previews');
export const TEMP_DIR = path.join(DATA_DIR, 'temp');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

for (const dir of [DATA_DIR, UPLOADS_DIR, OUTPUTS_DIR, PREVIEWS_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function findBinary(name) {
  try {
    const out = execSync(`where ${name}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {
    // fallback search below
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const wingetDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetDir)) {
    try {
      const entries = fs.readdirSync(wingetDir).filter((d) => d.toLowerCase().includes('ffmpeg'));
      for (const entry of entries) {
        const sub = path.join(wingetDir, entry);
        const stack = [sub];
        while (stack.length) {
          const cur = stack.pop();
          for (const item of fs.readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, item.name);
            if (item.isDirectory()) stack.push(full);
            else if (item.name.toLowerCase() === `${name}.exe`) return full;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return name;
}

export const FFMPEG_PATH = findBinary('ffmpeg');
export const FFPROBE_PATH = findBinary('ffprobe');

export const MUSE_PRESETS = {
  musevideos: {
    id: 'musevideos',
    name: 'MuseVideos API (musevideos.io)',
    baseUrl: 'https://musevideos.io/api/v1',
    createPath: '/videos',
    statusPath: '/videos/{id}',
    modelsPath: '/models',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'veo-3.1-fast',
    payloadStyle: 'musevideos',
    notes: 'Hỗ trợ Veo, Kling, Seedance, Wan, MiniMax... Endpoint chuẩn: POST /videos & GET /videos/{id}'
  },
  muse_ai_pro: {
    id: 'muse_ai_pro',
    name: 'Muse AI / Muse Video (muse-ai.pro)',
    baseUrl: 'https://muse-ai.pro/api/v1',
    createPath: '/generate',
    statusPath: '/status?task_id={id}',
    modelsPath: '',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'muse-video',
    payloadStyle: 'muse_ai_pro',
    notes: 'Endpoint chuẩn: POST /api/v1/generate & GET /api/v1/status?task_id={id}'
  },
  openai_videos: {
    id: 'openai_videos',
    name: 'Muse Video Gateway (/v1/videos - APIMart / APIMODELS / LaoZhang)',
    baseUrl: 'https://api.laozhang.ai/v1',
    createPath: '/videos',
    statusPath: '/videos/{id}',
    modelsPath: '/models',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'muse-video',
    payloadStyle: 'openai_videos',
    notes: 'Tương thích các cổng trung gian chạy model muse-video (POST /v1/videos)'
  },
  custom: {
    id: 'custom',
    name: 'Tùy chỉnh Endpoint (Custom REST API)',
    baseUrl: 'https://musevideos.io/api/v1',
    createPath: '/videos',
    statusPath: '/videos/{id}',
    modelsPath: '/models',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    defaultModel: 'muse-video',
    payloadStyle: 'musevideos',
    notes: 'Tự nhập Base URL, đường dẫn tạo task và đường dẫn kiểm tra trạng thái.'
  }
};

export const VIETNAMESE_VOICES = [
  { id: 'vi-VN-HoaiMyNeural', name: 'Hoài Mỹ (Nữ - Tiếng Việt tự nhiên)', lang: 'vi-VN', gender: 'Female' },
  { id: 'vi-VN-NamMinhNeural', name: 'Nam Minh (Nam - Tiếng Việt truyền cảm)', lang: 'vi-VN', gender: 'Male' },
  { id: 'en-US-AriaNeural', name: 'Aria (Female - English US)', lang: 'en-US', gender: 'Female' },
  { id: 'en-US-GuyNeural', name: 'Guy (Male - English US)', lang: 'en-US', gender: 'Male' },
  { id: 'en-US-JennyNeural', name: 'Jenny (Female - English US)', lang: 'en-US', gender: 'Female' },
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (Female - Chinese)', lang: 'zh-CN', gender: 'Female' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami (Female - Japanese)', lang: 'ja-JP', gender: 'Female' },
  { id: 'ko-KR-SunHiNeural', name: 'SunHi (Female - Korean)', lang: 'ko-KR', gender: 'Female' }
];

export const DEFAULT_SETTINGS = {
  muse: {
    preset: 'musevideos',
    apiKey: '',
    baseUrl: 'https://musevideos.io/api/v1',
    createPath: '/videos',
    statusPath: '/videos/{id}',
    modelsPath: '/models',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    model: 'veo-3.1-fast',
    payloadStyle: 'musevideos',
    duration: '8',
    resolution: '720p',
    generateAudio: true,
    pollIntervalSec: 5,
    maxWaitSec: 420,
    extraPayloadJson: '{}'
  },
  scriptAi: {
    baseUrl: 'https://api.meta.ai/v1',
    apiKey: '',
    model: 'muse-wonder-1.0'
  },
  production: {
    sourceMode: 'muse', // 'muse' | 'local_media' | 'demo'
    aspectRatio: '9:16', // '9:16' | '16:9' | '1:1'
    fitMode: 'crop', // 'crop' | 'blur'
    fps: 30,
    transition: 'fade', // xfade transition name
    transitionDuration: 0.5,
    concurrency: 2,
    retries: 1
  },
  tts: {
    enabled: true,
    voice: 'vi-VN-HoaiMyNeural',
    rate: '+5%',
    pitch: '+0Hz'
  },
  subtitles: {
    enabled: true,
    style: 'tiktok', // 'tiktok' | 'capcut' | 'classic'
    position: 'bottom', // 'bottom' | 'center' | 'top'
    fontFamily: 'Arial',
    fontSize: 64,
    primaryColor: '#FFFFFF',
    highlightColor: '#FFE600',
    outlineColor: '#000000',
    wordsPerLine: 4,
    showHookBanner: true,
    hookDurationSec: 3.5
  },
  audio: {
    bgmFile: '',
    bgmName: '',
    bgmVolume: 0.16,
    keepOriginalAudio: false,
    originalVolume: 0.3,
    voiceVolume: 1.0
  },
  watermark: {
    enabled: false,
    logoFile: '',
    logoName: '',
    position: 'top-right', // 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    scalePercent: 16,
    opacity: 0.85,
    marginPx: 32
  }
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

export function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return deepMerge(DEFAULT_SETTINGS, raw);
    }
  } catch (err) {
    console.error('[config] Failed to read settings.json:', err.message);
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(partial) {
  const current = loadSettings();
  const merged = deepMerge(current, partial);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function sanitizeSettingsForClient(settings) {
  const copy = structuredClone(settings);
  copy.muse.hasApiKey = Boolean(settings.muse.apiKey?.trim());
  copy.muse.apiKeyMasked = settings.muse.apiKey
    ? maskKey(settings.muse.apiKey)
    : '';
  // Keep raw apiKey out of GET response if user already saved it?
  // Wait: local app running on localhost, returning masked + keeping existing if placeholder submitted
  delete copy.muse.apiKey;
  copy.scriptAi.hasApiKey = Boolean(settings.scriptAi.apiKey?.trim());
  copy.scriptAi.apiKeyMasked = settings.scriptAi.apiKey
    ? maskKey(settings.scriptAi.apiKey)
    : '';
  delete copy.scriptAi.apiKey;
  return copy;
}

function maskKey(key) {
  const k = key.trim();
  if (k.length <= 8) return '••••••••';
  return `${k.slice(0, 5)}••••••${k.slice(-4)}`;
}

export function getResolutionForAspect(aspectRatio) {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '9:16':
    default:
      return { width: 1080, height: 1920 };
  }
}
