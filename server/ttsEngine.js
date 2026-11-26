import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'isomorphic-ws';
import { probeMedia } from './ffmpegEngine.js';
import { buildFallbackWordTimings } from './subtitleEngine.js';

const BASE_HOST = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;

let clockSkewSec = 0;

function generateSecMsGec() {
  let ticks = Date.now() / 1000 + clockSkewSec + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  return createHash('sha256')
    .update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

function escapeXml(str) {
  return String(str || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatVoiceName(shortVoice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortVoice);
  if (m) {
    let [, lang, region, name] = m;
    if (name.includes('-')) {
      const parts = name.split('-');
      region += `-${parts[0]}`;
      name = parts[1];
    }
    return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
  }
  return shortVoice;
}

function edgeTimestamp() {
  return new Date(Date.now() + clockSkewSec * 1000)
    .toUTCString()
    .replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function parseHeaders(buf, isBinary) {
  const headers = {};
  let body;
  if (isBinary) {
    if (buf.length < 2) return [headers, Buffer.alloc(0)];
    const headerLen = buf.readUInt16BE(0);
    const headerStr = buf.subarray(2, 2 + headerLen).toString('utf8');
    for (const line of headerStr.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    body = buf.subarray(2 + headerLen);
  } else {
    const str = buf.toString('utf8');
    const sep = str.indexOf('\r\n\r\n');
    const headerStr = sep >= 0 ? str.slice(0, sep) : str;
    for (const line of headerStr.split('\r\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    body = sep >= 0 ? str.slice(sep + 4) : '';
  }
  return [headers, body];
}

function runEdgeTtsOnce({ text, voice, rate, pitch, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const connId = randomUUID().replace(/-/g, '');
    const muid = randomBytes(16).toString('hex').toUpperCase();
    const url = `wss://${BASE_HOST}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Cookie: `muid=${muid};`
      },
      handshakeTimeout: 10000
    });

    const audioChunks = [];
    const wordTimings = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate?.() || ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`Edge-TTS quá thời gian chờ (${timeoutMs}ms)`));
    }, timeoutMs);

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(data);
    };

    ws.on('unexpected-response', (_req, res) => {
      const serverDate = res.headers?.date;
      const err = new Error(`Edge-TTS HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.serverDate = serverDate;
      finish(err);
    });

    ws.on('error', (err) => {
      finish(new Error(`Edge-TTS WebSocket lỗi: ${err.message}`));
    });

    ws.on('open', () => {
      const ts = edgeTimestamp();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
      );

      const safeRate = /^[+-]\d+%$/.test(rate) ? rate : '+0%';
      const safePitch = /^[+-]\d+Hz$/.test(pitch) ? pitch : '+0Hz';
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='${formatVoiceName(voice)}'><prosody pitch='${safePitch}' rate='${safeRate}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;

      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${ts}Z\r\n` +
          `Path:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        const [headers, payload] = parseHeaders(buf, true);
        if (headers.Path === 'audio' && payload.length > 0) {
          audioChunks.push(payload);
        }
      } else {
        const [headers, body] = parseHeaders(buf, false);
        if (headers.Path === 'audio.metadata') {
          try {
            const parsed = JSON.parse(body);
            for (const item of parsed.Metadata || []) {
              if (item.Type === 'WordBoundary' && item.Data) {
                const startMs = Math.round(item.Data.Offset / 10000);
                const durMs = Math.max(80, Math.round(item.Data.Duration / 10000));
                const word = item.Data.text?.Text || '';
                if (word.trim()) {
                  wordTimings.push({ text: word.trim(), startMs, endMs: startMs + durMs });
                }
              }
            }
          } catch {
            // ignore metadata parse glitches
          }
        } else if (headers.Path === 'turn.end') {
          const audioBuffer = Buffer.concat(audioChunks);
          if (audioBuffer.length < 100) {
            finish(new Error('Edge-TTS không trả về dữ liệu âm thanh.'));
          } else {
            finish(null, { audioBuffer, wordTimings });
          }
        }
      }
    });

    ws.on('close', () => {
      if (!settled) {
        const audioBuffer = Buffer.concat(audioChunks);
        if (audioBuffer.length >= 100) {
          finish(null, { audioBuffer, wordTimings });
        } else {
          finish(new Error('Edge-TTS đóng kết nối sớm trước khi nhận âm thanh.'));
        }
      }
    });
  });
}

async function synthesizeViaEdgeTts({ text, voice, rate, pitch }) {
  try {
    return await runEdgeTtsOnce({ text, voice, rate, pitch });
  } catch (err) {
    // Auto-correct clock skew from Microsoft server Date header on HTTP 403!
    if (err.statusCode === 403 && err.serverDate) {
      const serverSec = new Date(err.serverDate).getTime() / 1000;
      if (!Number.isNaN(serverSec)) {
        clockSkewSec = serverSec - Date.now() / 1000;
        return await runEdgeTtsOnce({ text, voice, rate, pitch });
      }
    }
    throw err;
  }
}

/**
 * Fallback TTS via Google Translate TTS (reliable free backup if Edge WebSocket is blocked).
 */
async function synthesizeViaGoogleTts({ text, voice }) {
  const lang = (voice || 'vi-VN').split('-')[0] || 'vi';
  // Split into clean <= 170-char sentence chunks
  const chunks = [];
  const words = text.split(/\s+/).filter(Boolean);
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 170) {
      if (cur) chunks.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) chunks.push(cur.trim());

  const buffers = [];
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Google TTS fallback HTTP ${res.status}`);
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }

  return { audioBuffer: Buffer.concat(buffers), wordTimings: [] };
}

/**
 * Synthesize speech (Edge-TTS Neural with clock-skew auto-fix + Google TTS fallback)
 * and return { audioPath, durationMs, wordTimings, engine }.
 */
export async function synthesizeVoiceover({
  text,
  voice = 'vi-VN-HoaiMyNeural',
  rate = '+5%',
  pitch = '+0Hz',
  outputPath
}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return { audioPath: null, durationMs: 0, wordTimings: [], engine: 'none' };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  let result;
  let engine = 'edge-tts';
  try {
    result = await synthesizeViaEdgeTts({ text: cleanText, voice, rate, pitch });
  } catch (edgeErr) {
    console.warn(`[tts] Edge-TTS failed (${edgeErr.message}), switching to Google TTS fallback...`);
    engine = 'google-tts-fallback';
    result = await synthesizeViaGoogleTts({ text: cleanText, voice });
  }

  fs.writeFileSync(outputPath, result.audioBuffer);
  const meta = await probeMedia(outputPath);
  const durationMs = Math.max(500, Math.round((meta.duration || 0) * 1000));

  let wordTimings = result.wordTimings || [];
  if (wordTimings.length === 0) {
    wordTimings = buildFallbackWordTimings(cleanText, durationMs);
  }

  return {
    audioPath: outputPath,
    durationMs,
    wordTimings,
    engine
  };
}
