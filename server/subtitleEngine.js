import fs from 'node:fs';
import path from 'node:path';
import { getResolutionForAspect } from './config.js';

/**
 * Convert #RRGGBB hex to ASS &H00BBGGRR format (alpha optional: 00 = opaque, FF = transparent)
 */
function hexToAssColor(hex, alphaHex = '00') {
  const clean = (hex || '#FFFFFF').replace('#', '').trim();
  if (clean.length !== 6) return `&H${alphaHex}FFFFFF`;
  const r = clean.slice(0, 2).toUpperCase();
  const g = clean.slice(2, 4).toUpperCase();
  const b = clean.slice(4, 6).toUpperCase();
  return `&H${alphaHex}${b}${g}${r}`;
}

/**
 * Format milliseconds to ASS timestamp H:MM:SS.cs (centiseconds)
 */
function formatAssTime(ms) {
  const safe = Math.max(0, Math.round(ms));
  const totalCs = Math.floor(safe / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  return `${hr}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

/**
 * If TTS did not provide per-word timestamps, estimate realistic word timings from total duration.
 */
export function buildFallbackWordTimings(scriptText, totalDurationMs) {
  const words = String(scriptText || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const totalWeight = words.reduce((acc, w) => acc + Math.max(2, w.length), 0);
  const usableMs = Math.max(1000, totalDurationMs - 200);
  let cursor = 100;
  return words.map((word) => {
    const weight = Math.max(2, word.length);
    const dur = Math.max(120, Math.round((weight / totalWeight) * usableMs));
    const item = { text: word, startMs: cursor, endMs: cursor + dur };
    cursor += dur;
    return item;
  });
}

/**
 * Group word timings into crisp short chunks (e.g. 3-5 words) suitable for TikTok/Reels/Shorts.
 */
function chunkWords(wordTimings, wordsPerLine = 4) {
  const chunks = [];
  let current = [];
  const maxWords = Math.max(2, Math.min(8, Number(wordsPerLine) || 4));

  for (let i = 0; i < wordTimings.length; i++) {
    const w = wordTimings[i];
    current.push(w);
    const endsSentence = /[.!?,;:…]$/.test(w.text);
    const nextGap = i + 1 < wordTimings.length ? wordTimings[i + 1].startMs - w.endMs : 0;
    const isLongPause = nextGap > 420;
    const charLen = current.reduce((s, x) => s + x.text.length + 1, 0);

    if (current.length >= maxWords || endsSentence || isLongPause || charLen >= 28) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function wrapTitleHook(text, maxCharsPerLine = 22) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) {
      line = w;
    } else if (line.length + 1 + w.length <= maxCharsPerLine) {
      line += ' ' + w;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\\N');
}

/**
 * Build a complete ASS subtitle file supporting TikTok word-by-word highlight, CapCut box, Classic,
 * plus an optional top Hook Title Banner.
 */
export function generateAssSubtitles({
  outputPath,
  wordTimings = [],
  scriptText = '',
  totalDurationMs = 8000,
  aspectRatio = '9:16',
  subtitlesConfig = {},
  hookText = ''
}) {
  const { width, height } = getResolutionForAspect(aspectRatio);
  const styleName = subtitlesConfig.style || 'tiktok';
  const position = subtitlesConfig.position || 'bottom';
  const fontFamily = subtitlesConfig.fontFamily || 'Arial';
  const baseFontSize = Number(subtitlesConfig.fontSize) || (aspectRatio === '9:16' ? 66 : 56);
  const primaryAss = hexToAssColor(subtitlesConfig.primaryColor || '#FFFFFF', '00');
  const highlightAss = hexToAssColor(subtitlesConfig.highlightColor || '#FFE600', '00');
  const outlineAss = hexToAssColor(subtitlesConfig.outlineColor || '#000000', '00');
  const wordsPerLine = Number(subtitlesConfig.wordsPerLine) || 4;

  // Alignment & vertical margin
  let alignment = 2; // bottom-center
  let marginV = aspectRatio === '9:16' ? 320 : 95;
  if (position === 'center') {
    alignment = 5;
    marginV = 0;
  } else if (position === 'top') {
    alignment = 8;
    marginV = aspectRatio === '9:16' ? 240 : 85;
  }

  // BorderStyle: 1 = outline + drop shadow, 3 = opaque box
  const isBox = styleName === 'capcut';
  const borderStyle = isBox ? 3 : 1;
  const outlineWidth = isBox ? 14 : styleName === 'tiktok' ? 6 : 3.5;
  const shadowDepth = isBox ? 0 : styleName === 'tiktok' ? 3 : 2;
  const backColor = isBox ? '&H66000000' : '&H88000000';

  const hookFontSize = Math.round(baseFontSize * 0.92);
  const hookMarginV = aspectRatio === '9:16' ? 160 : 54;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${fontFamily},${baseFontSize},${primaryAss},${highlightAss},${outlineAss},${backColor},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowDepth},${alignment},70,70,${marginV},1
Style: Hook,${fontFamily},${hookFontSize},&H00FFFFFF,&H0000E6FF,&H00121212,&H44000000,-1,0,0,0,100,100,1,0,3,16,0,8,80,80,${hookMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events = [];

  // Optional Hook Title Banner at top
  if (subtitlesConfig.showHookBanner && hookText && hookText.trim()) {
    const hookDurSec = Number(subtitlesConfig.hookDurationSec) || 3.5;
    const hookEndMs = hookDurSec <= 0
      ? totalDurationMs
      : Math.min(totalDurationMs, Math.round(hookDurSec * 1000));
    const wrapped = wrapTitleHook(escapeAssText(hookText.trim().toUpperCase()), aspectRatio === '9:16' ? 20 : 34);
    events.push(
      `Dialogue: 2,${formatAssTime(0)},${formatAssTime(hookEndMs)},Hook,,0,0,0,,{\\fad(180,260)}${wrapped}`
    );
  }

  // Word-by-word or chunk subtitles
  if (subtitlesConfig.enabled !== false) {
    const timings =
      wordTimings && wordTimings.length > 0
        ? wordTimings
        : buildFallbackWordTimings(scriptText, totalDurationMs);

    const chunks = chunkWords(timings, wordsPerLine);

    for (const chunk of chunks) {
      if (styleName === 'tiktok' || styleName === 'capcut') {
        // Emit one dialogue slice per active word so the active word pops in highlight color!
        for (let idx = 0; idx < chunk.length; idx++) {
          const activeWord = chunk[idx];
          const sliceStart = activeWord.startMs;
          const nextWord = chunk[idx + 1];
          const sliceEnd = nextWord ? Math.max(activeWord.endMs, nextWord.startMs) : activeWord.endMs + 120;

          const lineText = chunk
            .map((w, i) => {
              const escaped = escapeAssText(w.text);
              if (i === idx) {
                if (styleName === 'tiktok') {
                  return `{\\c${highlightAss}\\fscx110\\fscy110}${escaped}{\\c${primaryAss}\\fscx100\\fscy100}`;
                }
                return `{\\c${highlightAss}}${escaped}{\\c${primaryAss}}`;
              }
              return escaped;
            })
            .join(' ');

          events.push(
            `Dialogue: 1,${formatAssTime(sliceStart)},${formatAssTime(sliceEnd)},Main,,0,0,0,,${lineText}`
          );
        }
      } else {
        // Classic style: whole chunk displayed smoothly
        const startMs = chunk[0].startMs;
        const endMs = chunk[chunk.length - 1].endMs + 120;
        const text = chunk.map((w) => escapeAssText(w.text)).join(' ');
        events.push(
          `Dialogue: 1,${formatAssTime(startMs)},${formatAssTime(endMs)},Main,,0,0,0,,{\\fad(100,100)}${text}`
        );
      }
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, header + events.join('\n') + '\n', 'utf8');
  return { outputPath, eventCount: events.length };
}
