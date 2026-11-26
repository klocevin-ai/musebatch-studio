/* MuseBatch Studio Frontend Controller */
const state = {
  settings: null,
  presets: [],
  voices: [],
  queue: { isRunning: false, isPaused: false, activeCount: 0, jobs: [] },
  system: {},
  editingMediaFiles: [],
  activeLogJobId: null
};

const $ = (id) => document.getElementById(id);

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }
  if (!res.ok) throw new Error(await res.text());
  return res;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ==================== BOOTSTRAP & SSE ==================== */
async function init() {
  const data = await api('/api/bootstrap');
  state.settings = data.settings;
  state.presets = data.presets;
  state.voices = data.voices;
  state.queue = data.queue;
  state.system = data.system;

  populateDropdowns();
  syncSettingsToUI();
  renderAll();
  connectSSE();
  bindEvents();

  if (localStorage.getItem('musebatch_hide_guide') === '1') {
    $('guideBanner').classList.add('hidden');
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'init' || msg.type === 'jobs_changed' || msg.type === 'queue_state') {
        state.queue = msg.payload;
        renderAll();
      } else if (msg.type === 'job_updated') {
        const updated = msg.payload;
        const idx = state.queue.jobs.findIndex((j) => j.id === updated.id);
        if (idx >= 0) state.queue.jobs[idx] = updated;
        else state.queue.jobs.push(updated);
        renderAll();
        if (state.activeLogJobId === updated.id) {
          $('logsContent').textContent = (updated.logs || []).join('\n') || 'Chưa có log.';
        }
      }
    } catch {
      // ignore malformed SSE
    }
  };
}

function populateDropdowns() {
  const presetSel = $('cfgMusePreset');
  presetSel.innerHTML = state.presets
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join('');

  const voiceSel = $('cfgTtsVoice');
  voiceSel.innerHTML = state.voices
    .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
    .join('');
}

/* ==================== SETTINGS SYNC ==================== */
function syncSettingsToUI() {
  const s = state.settings;
  if (!s) return;

  // Topbar API Key pill
  const pill = $('apiKeyStatusPill');
  if (s.muse.hasApiKey) {
    pill.classList.add('ok');
    $('apiKeyStatusText').textContent = `Muse Key: ${s.muse.apiKeyMasked}`;
    $('cfgMuseKeyBadge').textContent = `Đã lưu (${s.muse.apiKeyMasked})`;
    $('cfgMuseKeyBadge').classList.add('saved');
  } else {
    pill.classList.remove('ok');
    $('apiKeyStatusText').textContent = 'Chưa nhập Muse API Key';
    $('cfgMuseKeyBadge').textContent = 'Chưa lưu';
    $('cfgMuseKeyBadge').classList.remove('saved');
  }

  // Muse API
  $('cfgMusePreset').value = s.muse.preset || 'musevideos';
  updatePresetNote();
  $('cfgMuseApiKey').value = '';
  $('cfgMuseApiKey').placeholder = s.muse.hasApiKey
    ? `Đã lưu: ${s.muse.apiKeyMasked} (để trống nếu giữ nguyên)`
    : 'Dán API Key của bạn (vd: sk-...)';
  $('cfgMuseBaseUrl').value = s.muse.baseUrl || '';
  $('cfgMuseModel').value = s.muse.model || '';
  $('cfgMuseDuration').value = String(s.muse.duration || '8');
  $('cfgMuseResolution').value = s.muse.resolution || '720p';
  $('cfgMuseCreatePath').value = s.muse.createPath || '/videos';
  $('cfgMuseStatusPath').value = s.muse.statusPath || '/videos/{id}';
  $('cfgMusePayloadStyle').value = s.muse.payloadStyle || 'musevideos';
  $('cfgMuseAuthHeader').value = s.muse.authHeader || 'Authorization';
  $('cfgMuseAuthPrefix').value = s.muse.authPrefix ?? 'Bearer ';
  $('cfgMusePollSec').value = s.muse.pollIntervalSec || 5;
  $('cfgMuseMaxWaitSec').value = s.muse.maxWaitSec || 420;
  $('cfgMuseExtraJson').value = s.muse.extraPayloadJson || '{}';
  $('cfgMuseGenAudio').checked = Boolean(s.muse.generateAudio);

  // Quick toolbar controls
  document.querySelectorAll('#quickSourceMode button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === s.production.sourceMode);
  });
  $('quickAspectRatio').value = s.production.aspectRatio || '9:16';
  $('quickConcurrency').value = String(s.production.concurrency || 2);

  // Production
  $('cfgAspectRatio').value = s.production.aspectRatio || '9:16';
  $('cfgFitMode').value = s.production.fitMode || 'crop';
  $('cfgTransition').value = s.production.transition || 'fade';
  $('cfgTransDur').value = s.production.transitionDuration || 0.5;
  $('lblTransDur').textContent = `${s.production.transitionDuration || 0.5}s`;
  $('cfgConcurrency').value = String(s.production.concurrency || 2);
  $('cfgRetries').value = String(s.production.retries ?? 1);

  // TTS
  $('cfgTtsEnabled').checked = s.tts.enabled !== false;
  $('cfgTtsVoice').value = s.tts.voice || 'vi-VN-HoaiMyNeural';
  const rateNum = parseInt(String(s.tts.rate || '+5%').replace('%', ''), 10) || 0;
  $('cfgTtsRate').value = rateNum;
  $('lblTtsRate').textContent = `${rateNum >= 0 ? '+' : ''}${rateNum}%`;
  const pitchNum = parseInt(String(s.tts.pitch || '+0Hz').replace(/Hz/i, ''), 10) || 0;
  $('cfgTtsPitch').value = pitchNum;
  $('lblTtsPitch').textContent = `${pitchNum >= 0 ? '+' : ''}${pitchNum}Hz`;

  // Subtitles
  $('cfgSubEnabled').checked = s.subtitles.enabled !== false;
  $('cfgSubStyle').value = s.subtitles.style || 'tiktok';
  $('cfgSubPos').value = s.subtitles.position || 'bottom';
  $('cfgSubFont').value = s.subtitles.fontFamily || 'Arial';
  $('cfgSubSize').value = s.subtitles.fontSize || 64;
  $('lblSubSize').textContent = `${s.subtitles.fontSize || 64}px`;
  $('cfgSubWords').value = String(s.subtitles.wordsPerLine || 4);
  $('cfgSubPrimary').value = s.subtitles.primaryColor || '#ffffff';
  $('cfgSubHighlight').value = s.subtitles.highlightColor || '#ffe600';
  $('cfgSubOutline').value = s.subtitles.outlineColor || '#000000';
  $('cfgShowHook').checked = s.subtitles.showHookBanner !== false;
  $('cfgHookDur').value = s.subtitles.hookDurationSec ?? 3.5;
  updateSubtitleLivePreview();

  // Audio / BGM
  if (s.audio.bgmFile) {
    $('bgmFileInfo').textContent = `🎵 Đang dùng: ${s.audio.bgmName || s.audio.bgmFile}`;
    $('bgmPlayer').src = `/uploads/${encodeURIComponent(s.audio.bgmFile)}`;
    $('bgmPlayer').classList.remove('hidden');
    $('btnRemoveBgm').classList.remove('hidden');
  } else {
    $('bgmFileInfo').textContent = 'Chưa chọn file nhạc nền (.mp3 / .wav)';
    $('bgmPlayer').classList.add('hidden');
    $('btnRemoveBgm').classList.add('hidden');
  }
  const bgmPct = Math.round((s.audio.bgmVolume ?? 0.16) * 100);
  $('cfgBgmVol').value = bgmPct;
  $('lblBgmVol').textContent = `${bgmPct}%`;
  const voicePct = Math.round((s.audio.voiceVolume ?? 1.0) * 100);
  $('cfgVoiceVol').value = voicePct;
  $('lblVoiceVol').textContent = `${voicePct}%`;
  $('cfgKeepOrigAudio').checked = Boolean(s.audio.keepOriginalAudio);
  const origPct = Math.round((s.audio.originalVolume ?? 0.3) * 100);
  $('cfgOrigVol').value = origPct;
  $('lblOrigVol').textContent = `${origPct}%`;

  // Watermark
  $('cfgWmEnabled').checked = Boolean(s.watermark.enabled);
  if (s.watermark.logoFile) {
    $('wmFileInfo').textContent = `🖼️ Logo: ${s.watermark.logoName || s.watermark.logoFile}`;
    $('wmPreviewImg').src = `/uploads/${encodeURIComponent(s.watermark.logoFile)}`;
    $('wmPreviewImg').classList.remove('hidden');
    $('btnRemoveWm').classList.remove('hidden');
  } else {
    $('wmFileInfo').textContent = 'Chưa chọn logo (.png / .webp)';
    $('wmPreviewImg').classList.add('hidden');
    $('btnRemoveWm').classList.add('hidden');
  }
  $('cfgWmPos').value = s.watermark.position || 'top-right';
  $('cfgWmMargin').value = s.watermark.marginPx ?? 32;
  $('cfgWmScale').value = s.watermark.scalePercent ?? 16;
  $('lblWmScale').textContent = `${s.watermark.scalePercent ?? 16}%`;
  const opPct = Math.round((s.watermark.opacity ?? 0.85) * 100);
  $('cfgWmOpacity').value = opPct;
  $('lblWmOpacity').textContent = `${opPct}%`;

  // Script AI
  $('cfgScriptBaseUrl').value = s.scriptAi.baseUrl || 'https://api.meta.ai/v1';
  $('cfgScriptModel').value = s.scriptAi.model || 'muse-wonder-1.0';
  $('cfgScriptApiKey').value = '';
  $('cfgScriptKeyBadge').textContent = s.scriptAi.hasApiKey ? `Đã lưu (${s.scriptAi.apiKeyMasked})` : '';
  $('cfgScriptKeyBadge').classList.toggle('saved', Boolean(s.scriptAi.hasApiKey));

  // System folder hint
  if (state.system.outputsDir) {
    $('galleryFolderHint').textContent = `Thư mục lưu cục bộ: ${state.system.outputsDir}`;
  }
}

function updatePresetNote() {
  const p = state.presets.find((x) => x.id === $('cfgMusePreset').value);
  $('cfgMusePresetNote').textContent = p?.notes || '';
}

function updateSubtitleLivePreview() {
  const style = $('cfgSubStyle').value;
  const pos = $('cfgSubPos').value;
  const font = $('cfgSubFont').value;
  const size = Number($('cfgSubSize').value) || 64;
  const primary = $('cfgSubPrimary').value;
  const highlight = $('cfgSubHighlight').value;
  const outline = $('cfgSubOutline').value;
  const showHook = $('cfgShowHook').checked;

  $('previewHookBox').classList.toggle('hidden', !showHook);
  const wrap = $('previewSubWrap');
  wrap.style.fontFamily = font;
  wrap.style.fontSize = `${Math.round(size * 0.38)}px`;
  wrap.style.color = primary;
  wrap.style.background = style === 'capcut' ? 'rgba(0,0,0,0.72)' : 'transparent';
  wrap.style.textShadow =
    style === 'capcut'
      ? 'none'
      : `0 2px 0 ${outline}, 2px 0 0 ${outline}, -2px 0 0 ${outline}, 0 -2px 0 ${outline}, 0 4px 10px rgba(0,0,0,0.8)`;

  const activeWord = $('previewActiveWord');
  activeWord.style.color = style === 'classic' ? primary : highlight;
  activeWord.style.transform = style === 'tiktok' ? 'scale(1.12)' : 'scale(1)';

  const stage = $('subPreviewStage');
  if (pos === 'top') stage.style.justifyContent = 'flex-start';
  else if (pos === 'center') stage.style.justifyContent = 'space-between';
  else stage.style.justifyContent = 'space-between';
}

function collectSettingsFromUI() {
  const rateVal = Number($('cfgTtsRate').value);
  const pitchVal = Number($('cfgTtsPitch').value);
  const activeModeBtn = document.querySelector('#quickSourceMode button.active');

  return {
    muse: {
      preset: $('cfgMusePreset').value,
      apiKey: $('cfgMuseApiKey').value.trim(),
      baseUrl: $('cfgMuseBaseUrl').value.trim(),
      model: $('cfgMuseModel').value.trim(),
      duration: $('cfgMuseDuration').value,
      resolution: $('cfgMuseResolution').value,
      createPath: $('cfgMuseCreatePath').value.trim(),
      statusPath: $('cfgMuseStatusPath').value.trim(),
      payloadStyle: $('cfgMusePayloadStyle').value,
      authHeader: $('cfgMuseAuthHeader').value.trim() || 'Authorization',
      authPrefix: $('cfgMuseAuthPrefix').value,
      pollIntervalSec: Number($('cfgMusePollSec').value) || 5,
      maxWaitSec: Number($('cfgMuseMaxWaitSec').value) || 420,
      extraPayloadJson: $('cfgMuseExtraJson').value.trim() || '{}',
      generateAudio: $('cfgMuseGenAudio').checked
    },
    production: {
      sourceMode: activeModeBtn ? activeModeBtn.dataset.value : state.settings.production.sourceMode,
      aspectRatio: $('cfgAspectRatio').value,
      fitMode: $('cfgFitMode').value,
      transition: $('cfgTransition').value,
      transitionDuration: Number($('cfgTransDur').value) || 0.5,
      concurrency: Number($('cfgConcurrency').value) || 2,
      retries: Number($('cfgRetries').value) || 0
    },
    tts: {
      enabled: $('cfgTtsEnabled').checked,
      voice: $('cfgTtsVoice').value,
      rate: `${rateVal >= 0 ? '+' : ''}${rateVal}%`,
      pitch: `${pitchVal >= 0 ? '+' : ''}${pitchVal}Hz`
    },
    subtitles: {
      enabled: $('cfgSubEnabled').checked,
      style: $('cfgSubStyle').value,
      position: $('cfgSubPos').value,
      fontFamily: $('cfgSubFont').value,
      fontSize: Number($('cfgSubSize').value) || 64,
      primaryColor: $('cfgSubPrimary').value,
      highlightColor: $('cfgSubHighlight').value,
      outlineColor: $('cfgSubOutline').value,
      wordsPerLine: Number($('cfgSubWords').value) || 4,
      showHookBanner: $('cfgShowHook').checked,
      hookDurationSec: Number($('cfgHookDur').value)
    },
    audio: {
      bgmVolume: Number($('cfgBgmVol').value) / 100,
      voiceVolume: Number($('cfgVoiceVol').value) / 100,
      keepOriginalAudio: $('cfgKeepOrigAudio').checked,
      originalVolume: Number($('cfgOrigVol').value) / 100
    },
    watermark: {
      enabled: $('cfgWmEnabled').checked,
      position: $('cfgWmPos').value,
      marginPx: Number($('cfgWmMargin').value) || 32,
      scalePercent: Number($('cfgWmScale').value) || 16,
      opacity: Number($('cfgWmOpacity').value) / 100
    },
    scriptAi: {
      baseUrl: $('cfgScriptBaseUrl').value.trim() || 'https://api.meta.ai/v1',
      apiKey: $('cfgScriptApiKey').value.trim(),
      model: $('cfgScriptModel').value.trim() || 'muse-wonder-1.0'
    }
  };
}

async function saveAllSettings(partial = null, silent = false) {
  const payload = partial || collectSettingsFromUI();
  const res = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  state.settings = res.settings;
  syncSettingsToUI();
  if (!silent) toast('Đã lưu cấu hình thành công!', 'success');
}

/* ==================== RENDER QUEUE & GALLERY ==================== */
function renderAll() {
  const jobs = state.queue.jobs || [];
  const total = jobs.length;
  const pending = jobs.filter((j) => j.status === 'pending').length;
  const running = jobs.filter((j) => j.status === 'running').length;
  const completed = jobs.filter((j) => j.status === 'completed').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;

  $('navQueueCount').textContent = total;
  $('navDoneCount').textContent = completed;
  $('statTotal').textContent = total;
  $('statPending').textContent = pending;
  $('statRunning').textContent = running;
  $('statCompleted').textContent = completed;
  $('statFailed').textContent = failed;

  // Header Start/Pause/Resume/Stop buttons
  const isRun = state.queue.isRunning;
  const isPause = state.queue.isPaused;
  $('btnStartQueue').classList.toggle('hidden', isRun);
  $('btnPauseQueue').classList.toggle('hidden', !isRun || isPause);
  $('btnResumeQueue').classList.toggle('hidden', !isRun || !isPause);
  $('btnStopQueue').classList.toggle('hidden', !isRun);

  // Master progress bar
  if (isRun || (total > 0 && completed > 0 && completed < total)) {
    const avgPct = total
      ? Math.round(
          jobs.reduce((acc, j) => acc + (j.status === 'completed' ? 100 : j.progress || 0), 0) / total
        )
      : 0;
    $('masterProgressWrap').classList.remove('hidden');
    $('masterProgressBar').style.width = `${avgPct}%`;
    $('masterProgressPct').textContent = `${avgPct}%`;
    $('masterProgressText').textContent = isPause
      ? `⏸ Đang tạm dừng (${completed}/${total} hoàn thành)`
      : isRun
        ? `⚡ Đang tạo hàng loạt (${running} luồng chạy • ${completed}/${total} xong)`
        : `Tiến độ lô hiện tại: ${completed}/${total} video hoàn thành`;
  } else {
    $('masterProgressWrap').classList.add('hidden');
  }

  renderJobsList(jobs);
  renderGallery(jobs.filter((j) => j.status === 'completed' && j.outputFile));
}

const STATUS_LABELS = {
  pending: 'Đang chờ',
  running: 'Đang chạy',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
  cancelled: 'Đã hủy'
};

const MODE_LABELS = {
  muse: '🤖 Muse API',
  local_media: '🖼️ Ảnh/Clip cục bộ',
  demo: '🎨 Demo Render'
};

function renderJobsList(jobs) {
  const container = $('jobsList');
  if (!jobs.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <h4>Chưa có video nào trong hàng đợi</h4>
        <p>Hãy bấm <strong>⚡ Nạp 3 mẫu thử</strong>, <strong>📂 Nhập CSV/Excel</strong>, hoặc <strong>📋 Dán hàng loạt</strong> để bắt đầu tạo video ngay!</p>
      </div>`;
    return;
  }

  container.innerHTML = jobs
    .map((job) => {
      const effMode = job.sourceMode || state.settings?.production?.sourceMode || 'muse';
      const effRatio = job.aspectRatio || state.settings?.production?.aspectRatio || '9:16';
      const sceneCount = job.prompt ? job.prompt.split('|').filter((s) => s.trim()).length : 0;
      const thumbHtml =
        job.status === 'completed' && job.thumbnailFile
          ? `<div class="job-thumb" data-action="play" data-id="${job.id}">
               <img src="/outputs/${encodeURIComponent(job.thumbnailFile)}" alt="" />
               <div class="play-overlay">▶</div>
             </div>`
          : `<div class="job-thumb" data-action="edit" data-id="${job.id}" title="Sửa video này">
               <span style="font-size:24px">${job.status === 'running' ? '⚙️' : job.status === 'failed' ? '⚠️' : '🎞️'}</span>
             </div>`;

      const mediaTag =
        (job.mediaFiles && job.mediaFiles.length > 0) || job.referenceImage
          ? `<span class="tag-chip">📎 ${job.mediaFiles?.length || 1} media</span>`
          : '';

      return `
        <div class="job-card status-${job.status}">
          ${thumbHtml}
          <div class="job-body">
            <div class="job-top-line">
              <span class="job-title">${escapeHtml(job.title)}</span>
              <span class="status-pill ${job.status}">${STATUS_LABELS[job.status] || job.status}</span>
              <span class="tag-chip">${MODE_LABELS[effMode] || effMode}</span>
              <span class="tag-chip">${escapeHtml(effRatio)}</span>
              ${sceneCount > 1 ? `<span class="tag-chip">🎞️ ${sceneCount} cảnh</span>` : ''}
              ${job.durationSec ? `<span class="tag-chip">⏱️ ${job.durationSec}s</span>` : ''}
              ${mediaTag}
            </div>

            <div class="job-meta-lines">
              ${job.prompt ? `<div><strong>Prompt:</strong> ${escapeHtml(job.prompt)}</div>` : ''}
              ${job.script ? `<div><strong>Lời thoại:</strong> ${escapeHtml(job.script)}</div>` : ''}
            </div>

            <div class="job-progress-row">
              <div class="progress-track">
                <div class="progress-fill" style="width:${job.status === 'completed' ? 100 : job.progress || 0}%"></div>
              </div>
              <span class="job-step-label">${escapeHtml(job.step || '')} ${job.status === 'running' ? `(${job.progress || 0}%)` : ''}</span>
            </div>

            ${job.error ? `<div class="job-error-box">❌ ${escapeHtml(job.error)}</div>` : ''}
          </div>

          <div class="job-actions">
            ${
              job.status === 'completed' && job.outputFile
                ? `<button class="btn btn-sm btn-primary" data-action="play" data-id="${job.id}">▶ Xem</button>
                   <a class="btn btn-sm btn-secondary" href="/outputs/${encodeURIComponent(job.outputFile)}" download>⬇ MP4</a>`
                : ''
            }
            <button class="btn btn-sm btn-ghost" data-action="logs" data-id="${job.id}" title="Xem nhật ký">📜</button>
            ${
              job.status !== 'running'
                ? `<button class="btn btn-sm btn-ghost" data-action="edit" data-id="${job.id}" title="Sửa">✏️</button>
                   <button class="btn btn-sm btn-ghost" data-action="retry" data-id="${job.id}" title="Chạy lại">↻</button>`
                : ''
            }
            <button class="btn btn-sm btn-ghost text-danger" data-action="delete" data-id="${job.id}" title="Xóa">🗑</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderGallery(completedJobs) {
  const grid = $('galleryGrid');
  if (!completedJobs.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">🎥</div>
        <h4>Chưa có video nào hoàn thành</h4>
        <p>Chạy hàng đợi để xuất video MP4 — tất cả video sẽ xuất hiện ngay tại đây.</p>
      </div>`;
    return;
  }

  grid.innerHTML = completedJobs
    .slice()
    .reverse()
    .map(
      (job) => `
      <div class="gallery-card">
        <div class="gallery-thumb" data-action="play" data-id="${job.id}">
          ${
            job.thumbnailFile
              ? `<img src="/outputs/${encodeURIComponent(job.thumbnailFile)}" alt="" />`
              : ''
          }
          <div class="play-btn">▶</div>
          <span class="dur-badge">${job.durationSec ? `${job.durationSec}s` : 'MP4'}</span>
        </div>
        <div class="gallery-info">
          <h4 title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</h4>
          <div class="hint">${escapeHtml(job.outputFile)}</div>
          <div class="gallery-actions">
            <button class="btn btn-sm btn-primary" data-action="play" data-id="${job.id}">▶ Xem</button>
            <a class="btn btn-sm btn-secondary" href="/outputs/${encodeURIComponent(job.outputFile)}" download>⬇ Tải MP4</a>
          </div>
        </div>
      </div>`
    )
    .join('');
}

/* ==================== MODAL HELPERS ==================== */
function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(id) {
  $(id).classList.add('hidden');
  if (id === 'playerModal') {
    $('lightboxVideo').pause();
    $('lightboxVideo').removeAttribute('src');
  }
  if (id === 'logsModal') state.activeLogJobId = null;
}

function openJobEditor(job = null) {
  $('editJobId').value = job ? job.id : '';
  $('jobModalTitle').textContent = job ? `Chỉnh sửa: ${job.title}` : 'Thêm video mới vào hàng đợi';
  $('jobTitle').value = job?.title || '';
  $('jobHook').value = job?.hookText || '';
  $('jobPrompt').value = job?.prompt || '';
  $('jobScript').value = job?.script || '';
  $('jobSourceMode').value = job?.sourceMode || '';
  $('jobAspectRatio').value = job?.aspectRatio || '';
  $('jobDuration').value = job?.duration || '';
  $('jobRefImage').value = job?.referenceImage || '';
  state.editingMediaFiles = Array.isArray(job?.mediaFiles) ? [...job.mediaFiles] : [];
  renderEditingMediaChips();
  openModal('jobModal');
}

function renderEditingMediaChips() {
  $('jobMediaChips').innerHTML = state.editingMediaFiles
    .map(
      (f, idx) => `
      <span class="chip">
        📎 ${escapeHtml(f)}
        <button type="button" data-remove-chip="${idx}">×</button>
      </span>`
    )
    .join('');
}

function openPlayer(jobId) {
  const job = state.queue.jobs.find((j) => j.id === jobId);
  if (!job || !job.outputFile) return;
  const url = `/outputs/${encodeURIComponent(job.outputFile)}`;
  $('playerTitle').textContent = `${job.title} (${job.durationSec || '?'}s)`;
  $('lightboxVideo').src = url;
  $('playerDownloadLink').href = url;
  $('playerDownloadLink').download = job.outputFile;
  openModal('playerModal');
  $('lightboxVideo').play().catch(() => {});
}

function openLogs(jobId) {
  const job = state.queue.jobs.find((j) => j.id === jobId);
  if (!job) return;
  state.activeLogJobId = job.id;
  $('logsModalTitle').textContent = `Nhật ký: ${job.title}`;
  $('logsContent').textContent = (job.logs || []).join('\n') || 'Job chưa chạy nên chưa có nhật ký.';
  openModal('logsModal');
}

function switchTab(tabName) {
  document.querySelectorAll('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
}

/* ==================== SAMPLE BATCH LOADER ==================== */
async function loadSampleBatch() {
  const samples = [
    {
      title: 'Bí quyết ngủ sâu trong 5 phút',
      hookText: 'BÍ QUYẾT NGỦ NGON TỨC THÌ',
      prompt:
        'Cinematic peaceful glowing bedroom at midnight, soft rain drops on glass window, warm ambient moonlight, ultra realistic 4k | Slow motion steaming chamomile tea cup on wooden desk, cozy cinematic lighting',
      script:
        'Bạn có biết chỉ cần hạ nhẹ nhiệt độ phòng và tắt ánh sáng xanh ba mươi phút trước khi ngủ, chất lượng giấc ngủ sẽ tăng gấp đôi ngay tối nay!'
    },
    {
      title: 'Cà phê sáng Sài Gòn',
      hookText: 'MỘT LY CÀ PHÊ ĐỔI CẢ NGÀY DÀI',
      prompt:
        'Golden hour drone shot over bustling Ho Chi Minh City streets at sunrise, warm mist, cinematic color grading | Macro slow motion Vietnamese iced coffee dripping into condensed milk, rich amber light',
      script:
        'Sài Gòn thức dậy cùng mùi thơm cà phê sữa đá đậm đà. Một khoảnh khắc nhỏ mỗi sáng nhưng đủ nạp đầy năng lượng cho cả ngày bứt phá!'
    },
    {
      title: 'Tự động hóa video AI 2026',
      hookText: 'SẢN XUẤT 50 VIDEO MỖI NGÀY',
      prompt:
        'Futuristic dark creative studio with glowing holographic timeline screens floating in air, neon indigo and violet lighting, smooth cinematic camera orbit',
      script:
        'Trí tuệ nhân tạo không thay thế nhà sáng tạo, nhưng người biết dùng công cụ sản xuất video hàng loạt chắc chắn sẽ đi nhanh gấp mười lần!'
    }
  ];
  await api('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobs: samples })
  });
  toast('Đã nạp 3 kịch bản video mẫu vào hàng đợi!', 'success');
}

/* ==================== EVENT LISTENERS ==================== */
function bindEvents() {
  // Tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('apiKeyStatusPill').addEventListener('click', () => switchTab('settings'));
  $('btnGoApiSetup').addEventListener('click', () => switchTab('settings'));
  $('btnCloseGuide').addEventListener('click', () => {
    $('guideBanner').classList.add('hidden');
    localStorage.setItem('musebatch_hide_guide', '1');
  });

  // Quick source mode, ratio, concurrency
  document.querySelectorAll('#quickSourceMode button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('#quickSourceMode button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await saveAllSettings({ production: { sourceMode: btn.dataset.value } }, true);
      toast(`Đã chuyển chế độ nguồn sang: ${btn.textContent.trim()}`);
    });
  });

  $('quickAspectRatio').addEventListener('change', async (e) => {
    await saveAllSettings({ production: { aspectRatio: e.target.value } }, true);
  });

  $('quickConcurrency').addEventListener('change', async (e) => {
    await saveAllSettings({ production: { concurrency: Number(e.target.value) } }, true);
  });

  // Queue controls
  $('btnStartQueue').addEventListener('click', async () => {
    if (!state.queue.jobs.some((j) => j.status === 'pending')) {
      return toast('Không có video nào đang chờ. Hãy thêm video hoặc bấm Chạy lại!', 'error');
    }
    const mode = state.settings?.production?.sourceMode;
    if (mode === 'muse' && !state.settings?.muse?.hasApiKey) {
      toast('Bạn chưa dán Muse API Key! Hãy vào Cài đặt API hoặc chuyển sang Demo Render.', 'error');
      switchTab('settings');
      return;
    }
    await api('/api/queue/start', { method: 'POST' });
    toast('🚀 Đã bắt đầu chạy hàng loạt!', 'success');
  });

  $('btnPauseQueue').addEventListener('click', () => api('/api/queue/pause', { method: 'POST' }));
  $('btnResumeQueue').addEventListener('click', () => api('/api/queue/resume', { method: 'POST' }));
  $('btnStopQueue').addEventListener('click', () => api('/api/queue/stop', { method: 'POST' }));
  $('btnRetryFailed').addEventListener('click', () => api('/api/queue/retry-failed', { method: 'POST' }));
  $('btnClearCompleted').addEventListener('click', () => api('/api/queue/clear-completed', { method: 'POST' }));
  $('btnClearAll').addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ danh sách hàng đợi hiện tại?')) return;
    await api('/api/queue/clear-all', { method: 'POST' });
  });

  const downloadZip = () => {
    window.location.href = '/api/outputs/zip';
  };
  $('btnDownloadZip').addEventListener('click', downloadZip);
  $('btnGalleryZip').addEventListener('click', downloadZip);

  const openOutputs = async () => {
    try {
      await api('/api/system/open-outputs', { method: 'POST' });
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  $('btnOpenOutputs').addEventListener('click', openOutputs);
  $('btnGalleryOpenFolder').addEventListener('click', openOutputs);

  // Batch adders
  $('btnAddSingle').addEventListener('click', () => openJobEditor(null));
  $('btnBulkPaste').addEventListener('click', () => openModal('bulkPasteModal'));
  $('btnOpenAiGenerator').addEventListener('click', () => openModal('aiGenModal'));
  $('btnLoadSamples').addEventListener('click', loadSampleBatch);
  $('btnLoadSamplesQuick').addEventListener('click', loadSampleBatch);

  // Import CSV / Excel / TXT
  $('importBatchFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api('/api/jobs/import', { method: 'POST', body: fd });
      toast(`Đã nhập thành công ${res.addedCount} video từ ${file.name}!`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  // Save single job
  $('btnSaveJob').addEventListener('click', async () => {
    const id = $('editJobId').value;
    const payload = {
      title: $('jobTitle').value.trim() || `Video ${state.queue.jobs.length + 1}`,
      hookText: $('jobHook').value.trim(),
      prompt: $('jobPrompt').value.trim(),
      script: $('jobScript').value.trim(),
      sourceMode: $('jobSourceMode').value,
      aspectRatio: $('jobAspectRatio').value,
      duration: $('jobDuration').value,
      referenceImage: $('jobRefImage').value.trim(),
      mediaFiles: state.editingMediaFiles
    };

    try {
      if (id) {
        await api(`/api/jobs/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        toast('Đã cập nhật video!', 'success');
      } else {
        await api('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        toast('Đã thêm video vào hàng đợi!', 'success');
      }
      closeModal('jobModal');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // Upload media attachments inside single job modal
  $('jobMediaInput').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    try {
      const res = await api('/api/upload/asset', { method: 'POST', body: fd });
      for (const f of res.files) {
        state.editingMediaFiles.push(f.filename);
      }
      if (!$('jobRefImage').value && res.files[0]) {
        $('jobRefImage').value = res.files[0].filename;
      }
      renderEditingMediaChips();
      toast(`Đã đính kèm ${res.files.length} file!`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  $('jobMediaChips').addEventListener('click', (e) => {
    const idx = e.target.dataset?.removeChip;
    if (idx !== undefined) {
      state.editingMediaFiles.splice(Number(idx), 1);
      renderEditingMediaChips();
    }
  });

  // Submit bulk paste
  $('btnSubmitBulkPaste').addEventListener('click', async () => {
    const lines = $('bulkPasteText')
      .value.split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return toast('Hãy dán ít nhất 1 dòng!', 'error');

    const jobs = lines.map((line, i) => {
      const parts = line.split(';;').map((p) => p.trim());
      if (parts.length >= 3) {
        return { title: parts[0], prompt: parts[1], script: parts[2], hookText: parts[3] || parts[0] };
      }
      if (parts.length === 2) {
        return { title: `Video ${i + 1}`, prompt: parts[0], script: parts[1] };
      }
      return { title: `Video ${state.queue.jobs.length + i + 1}`, prompt: line, script: '' };
    });

    await api('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobs })
    });
    $('bulkPasteText').value = '';
    closeModal('bulkPasteModal');
    toast(`Đã thêm ${jobs.length} video vào hàng đợi!`, 'success');
  });

  // AI Script Batch Generator
  $('btnRunAiGen').addEventListener('click', async () => {
    const topic = $('aiTopic').value.trim();
    const count = Number($('aiCount').value) || 5;
    const style = $('aiStyle').value.trim();
    const errBox = $('aiGenError');
    errBox.classList.add('hidden');
    if (!topic) return toast('Hãy nhập chủ đề trước!', 'error');

    const btn = $('btnRunAiGen');
    btn.disabled = true;
    btn.textContent = '⏳ Đang sinh kịch bản...';
    try {
      const res = await api('/api/ai/generate-ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, count, style })
      });
      toast(`AI đã tạo thành công ${res.addedCount} kịch bản video!`, 'success');
      closeModal('aiGenModal');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Sinh kịch bản ngay';
    }
  });

  // Delegated click for job cards & gallery cards
  document.body.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    if (action === 'play') openPlayer(id);
    else if (action === 'logs') openLogs(id);
    else if (action === 'edit') {
      const job = state.queue.jobs.find((j) => j.id === id);
      if (job) openJobEditor(job);
    } else if (action === 'retry') {
      await api(`/api/jobs/${id}/retry`, { method: 'POST' });
      toast('Đã đưa video về trạng thái chờ chạy lại.');
    } else if (action === 'delete') {
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
    }
  });

  // Close modals
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd) closeModal(bd.id);
    });
  });

  // Preset switch auto-fills endpoints
  $('cfgMusePreset').addEventListener('change', () => {
    const p = state.presets.find((x) => x.id === $('cfgMusePreset').value);
    if (p && p.id !== 'custom') {
      $('cfgMuseBaseUrl').value = p.baseUrl;
      $('cfgMuseCreatePath').value = p.createPath;
      $('cfgMuseStatusPath').value = p.statusPath;
      $('cfgMusePayloadStyle').value = p.payloadStyle;
      $('cfgMuseModel').value = p.defaultModel;
      $('cfgMuseAuthHeader').value = p.authHeader;
      $('cfgMuseAuthPrefix').value = p.authPrefix;
    }
    updatePresetNote();
  });

  $('btnToggleMuseKey').addEventListener('click', () => {
    const inp = $('cfgMuseApiKey');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Test Muse API connection
  $('btnTestMuse').addEventListener('click', async () => {
    const btn = $('btnTestMuse');
    const box = $('museTestResult');
    btn.disabled = true;
    btn.textContent = '⏳ Đang kiểm tra...';
    box.classList.add('hidden');
    try {
      const muse = collectSettingsFromUI().muse;
      const res = await api('/api/muse/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(muse)
      });
      box.className = `alert ${res.ok ? 'alert-success' : 'alert-danger'}`;
      box.textContent = res.message;
      box.classList.remove('hidden');

      if (res.ok && Array.isArray(res.models) && res.models.length > 0) {
        $('museModelsDatalist').innerHTML = res.models
          .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`)
          .join('');
      }
    } catch (err) {
      box.className = 'alert alert-danger';
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔌 Kiểm tra kết nối & Tải Models';
    }
  });

  // Live slider labels & subtitle preview
  $('cfgTransDur').addEventListener('input', (e) => ($('lblTransDur').textContent = `${e.target.value}s`));
  $('cfgTtsRate').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('lblTtsRate').textContent = `${v >= 0 ? '+' : ''}${v}%`;
  });
  $('cfgTtsPitch').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('lblTtsPitch').textContent = `${v >= 0 ? '+' : ''}${v}Hz`;
  });
  $('cfgSubSize').addEventListener('input', (e) => {
    $('lblSubSize').textContent = `${e.target.value}px`;
    updateSubtitleLivePreview();
  });
  ['cfgSubStyle', 'cfgSubPos', 'cfgSubFont', 'cfgSubPrimary', 'cfgSubHighlight', 'cfgSubOutline', 'cfgShowHook'].forEach(
    (id) => $(id).addEventListener('input', updateSubtitleLivePreview)
  );
  $('cfgBgmVol').addEventListener('input', (e) => ($('lblBgmVol').textContent = `${e.target.value}%`));
  $('cfgVoiceVol').addEventListener('input', (e) => ($('lblVoiceVol').textContent = `${e.target.value}%`));
  $('cfgOrigVol').addEventListener('input', (e) => ($('lblOrigVol').textContent = `${e.target.value}%`));
  $('cfgWmScale').addEventListener('input', (e) => ($('lblWmScale').textContent = `${e.target.value}%`));
  $('cfgWmOpacity').addEventListener('input', (e) => ($('lblWmOpacity').textContent = `${e.target.value}%`));

  // TTS Live Preview
  $('btnPreviewTts').addEventListener('click', async () => {
    const btn = $('btnPreviewTts');
    btn.disabled = true;
    btn.textContent = '⏳ Đang tạo giọng mẫu...';
    try {
      const cfg = collectSettingsFromUI().tts;
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Lỗi tạo giọng thử' }));
        throw new Error(err.error);
      }
      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = $('ttsPreviewAudio');
      audio.src = audioUrl;
      audio.classList.remove('hidden');
      audio.play().catch(() => {});
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🔊 Nghe thử giọng đọc';
    }
  });

  // Upload BGM
  $('bgmFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('files', file);
    try {
      const res = await api('/api/upload/asset', { method: 'POST', body: fd });
      const uploaded = res.files[0];
      await saveAllSettings({ audio: { bgmFile: uploaded.filename, bgmName: uploaded.originalName } }, true);
      toast(`Đã tải nhạc nền: ${uploaded.originalName}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  $('btnRemoveBgm').addEventListener('click', async () => {
    await saveAllSettings({ audio: { bgmFile: '', bgmName: '' } }, true);
    toast('Đã gỡ nhạc nền.');
  });

  // Upload Watermark Logo
  $('wmFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('files', file);
    try {
      const res = await api('/api/upload/asset', { method: 'POST', body: fd });
      const uploaded = res.files[0];
      await saveAllSettings(
        { watermark: { enabled: true, logoFile: uploaded.filename, logoName: uploaded.originalName } },
        true
      );
      toast(`Đã tải logo: ${uploaded.originalName}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      e.target.value = '';
    }
  });

  $('btnRemoveWm').addEventListener('click', async () => {
    await saveAllSettings({ watermark: { enabled: false, logoFile: '', logoName: '' } }, true);
    toast('Đã gỡ logo.');
  });

  // Save All Settings
  $('btnSaveSettings').addEventListener('click', () => saveAllSettings());
}

init().catch((err) => {
  console.error(err);
  toast(`Lỗi khởi động ứng dụng: ${err.message}`, 'error');
});
