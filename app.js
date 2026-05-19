const FFT_SIZE = 2048;
const SPEC_COLS = 1024;

const PRESETS = [
  {
    id: 'presetEU',
    filters: [{freq: 50, q: 30, type: 'notch'}, {freq: 100, q: 30, type: 'notch'}, {freq: 150, q: 30, type: 'notch'}],
  },
  {
    id: 'presetUS',
    filters: [{freq: 60, q: 30, type: 'notch'}, {freq: 120, q: 30, type: 'notch'}, {freq: 180, q: 30, type: 'notch'}],
  },
  {
    id: 'presetRumble',
    filters: [{freq: 80, q: 0.71, type: 'highpass'}],
  },
  {
    id: 'presetHiss',
    filters: [{freq: 12000, q: 0.71, type: 'lowpass'}],
  },
];

// Core state
let playbackCtx = null;
let previewOffsetAtStart = 0;
let srcBuffer = null;
let specMags = null;
let specMaxMag = 0;
let viewStart = 0;
let viewEnd = 1;
let filters = [];
let previewSource = null;

// Selection state
let selStart = null;
let selEnd = null;
let selAnchor = null;
let isSelecting = false;

// Interaction state
let isDragging = false;
let dragStartX = 0;
let dragStartViewStart = 0;
let dragStartViewEnd = 1;
let isScrollbarDragging = false;
let scrollbarDragStartX = 0;
let scrollbarDragStartViewStart = 0;
let scrollbarDragStartViewEnd = 1;

// History (undo/redo)
let history = [];
let historyIndex = -1;

// DOM refs
let elDropZone, elFileInput, elAudioInfo, elFileName;
let elWaveformCanvas, elSpectrogramCanvas;
let elSpectrogramOverlay, elSpectrogramProgress, elWaveformTime;
let elSelectionInfo, elSelectionTimeLabel;
let elScrollbar, elScrollThumb;
let elFilterFreq, elFilterQ, elFilterType, elFilterList;
let elDetectionResults, elDetectionList;
let elBtnUndo, elBtnRedo;
let elBtnPreview, elBtnStop, elBtnExport, elExportFormat;

document.addEventListener('DOMContentLoaded', () => {
  elDropZone = document.getElementById('dropZone');
  elFileInput = document.getElementById('fileInput');
  elAudioInfo = document.getElementById('audioInfo');
  elFileName = document.getElementById('fileName');
  elWaveformCanvas = document.getElementById('waveformCanvas');
  elSpectrogramCanvas = document.getElementById('spectrogramCanvas');
  elSpectrogramOverlay = document.getElementById('spectrogramOverlay');
  elSpectrogramProgress = document.getElementById('spectrogramProgress');
  elWaveformTime = document.getElementById('waveformTime');
  elSelectionInfo = document.getElementById('selectionInfo');
  elSelectionTimeLabel = document.getElementById('selectionTimeLabel');
  elScrollbar = document.getElementById('spectrogramScrollbar');
  elScrollThumb = document.getElementById('spectrogramScrollThumb');
  elFilterFreq = document.getElementById('filterFreq');
  elFilterQ = document.getElementById('filterQ');
  elFilterType = document.getElementById('filterType');
  elFilterList = document.getElementById('filterList');
  elDetectionResults = document.getElementById('detectionResults');
  elDetectionList = document.getElementById('detectionList');
  elBtnUndo = document.getElementById('btnUndo');
  elBtnRedo = document.getElementById('btnRedo');
  elBtnPreview = document.getElementById('btnPreview');
  elBtnStop = document.getElementById('btnStop');
  elBtnExport = document.getElementById('btnExport');
  elExportFormat = document.getElementById('exportFormat');

  // File input
  elDropZone.addEventListener('click', () => elFileInput.click());
  elDropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    elDropZone.classList.add('dragover');
  });
  elDropZone.addEventListener('dragleave', () => elDropZone.classList.remove('dragover'));
  elDropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    elDropZone.classList.remove('dragover');
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  elFileInput.addEventListener('change', () => {
    if (elFileInput.files[0]) loadFile(elFileInput.files[0]);
  });

  // Reset
  document.getElementById('btnReset').addEventListener('click', resetState);
  document.getElementById('btnResetFilters').addEventListener('click', () => {
    filters = [];
    saveHistory();
    renderFilterList();
    drawSpectrogram();
  });

  // Waveform interaction
  elWaveformCanvas.addEventListener('wheel', handleWheel, { passive: false });
  elWaveformCanvas.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.getElementById('btnZoomIn').addEventListener('click', () => zoomAround(0.5, 0.5));
  document.getElementById('btnZoomOut').addEventListener('click', () => zoomAround(0.5, 2));
  document.getElementById('btnZoomReset').addEventListener('click', resetZoom);

  // Spectrogram interaction
  elSpectrogramCanvas.addEventListener('click', handleSpectrogramClick);
  elSpectrogramCanvas.addEventListener('wheel', handleWheel, { passive: false });

  // Scrollbar
  elScrollbar.addEventListener('mousedown', handleScrollbarMouseDown);

  // Selection
  document.getElementById('btnClearSel').addEventListener('click', clearSelection);

  // Filters
  document.getElementById('btnAddFilter').addEventListener('click', () => {
    const freq = parseFloat(elFilterFreq.value);
    const q = parseFloat(elFilterQ.value);
    const type = elFilterType.value;
    if (freq > 0 && q > 0) addFilter(freq, q, type);
  });

  elFilterType.addEventListener('change', () => {
    elFilterQ.value = elFilterType.value === 'notch' ? 30 : 0.71;
  });
  document.getElementById('btnDetect').addEventListener('click', () => {
    const bands = detectBands();
    if (bands.length > 0) {
      const q = parseFloat(elFilterQ.value) || 30;
      bands.forEach(b => addFilter(b.freq, q));
    }
    renderDetectionResults(bands);
  });

  PRESETS.forEach(preset => {
    document.getElementById(preset.id).addEventListener('click', () => {
      preset.filters.forEach(f => addFilter(f.freq, f.q));
    });
  });

  // History
  elBtnUndo.addEventListener('click', undo);
  elBtnRedo.addEventListener('click', redo);
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); }
      if (event.key === 'z' && event.shiftKey) { event.preventDefault(); redo(); }
      if (event.key === 'y') { event.preventDefault(); redo(); }
    }
  });

  // Actions
  elBtnPreview.addEventListener('click', () => startPreview());
  elBtnStop.addEventListener('click', stopPreview);
  elBtnExport.addEventListener('click', exportAudio);

  // Resize
  new ResizeObserver(() => {
    if (srcBuffer) { drawWaveform(); drawSpectrogram(); }
  }).observe(elAudioInfo);
});

// File loading

async function loadFile(file) {
  stopPreview();

  elDropZone.classList.add('d-none');
  elAudioInfo.classList.remove('d-none');
  elFileName.textContent = file.name;
  elSpectrogramOverlay.classList.remove('d-none');
  elSpectrogramProgress.textContent = 'Decoding…';

  // Use a short-lived context only for decoding; playback gets its own fresh context per play.
  const decodeCtx = new AudioContext();
  const arrayBuffer = await file.arrayBuffer();
  srcBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  decodeCtx.close();

  viewStart = 0;
  viewEnd = 1;
  filters = [];
  selStart = null;
  selEnd = null;
  history = [[]];
  historyIndex = 0;

  renderFilterList();
  updateUndoRedoButtons();
  clearSelection();
  drawWaveform();
  updateScrollbar();

  elDetectionResults.classList.add('d-none');
  elSpectrogramProgress.textContent = 'Analyzing…';
  await computeSpectrogram();
  drawSpectrogram();
  elSpectrogramOverlay.classList.add('d-none');
}

function resetState() {
  stopPreview();
  srcBuffer = null;
  specMags = null;
  specMaxMag = 0;
  viewStart = 0;
  viewEnd = 1;
  filters = [];
  selStart = null;
  selEnd = null;
  history = [];
  historyIndex = -1;
  elAudioInfo.classList.add('d-none');
  elDropZone.classList.remove('d-none');
  elFileInput.value = '';
}

// Waveform

function drawWaveform() {
  if (!srcBuffer) return;
  const canvas = elWaveformCanvas;
  canvas.width = canvas.clientWidth || 800;
  canvas.height = canvas.clientHeight || 120;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, width, height);

  // Selection overlay
  if (selStart !== null && selEnd !== null) {
    const x1 = Math.max(0, (selStart - viewStart) / (viewEnd - viewStart)) * width;
    const x2 = Math.min(1, (selEnd - viewStart) / (viewEnd - viewStart)) * width;
    if (x2 > x1) {
      ctx.fillStyle = 'rgba(255,200,50,0.18)';
      ctx.fillRect(x1, 0, x2 - x1, height);
      ctx.strokeStyle = 'rgba(255,200,50,0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, 0); ctx.lineTo(x1, height);
      ctx.moveTo(x2, 0); ctx.lineTo(x2, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const data = srcBuffer.getChannelData(0);
  const startSample = Math.floor(viewStart * data.length);
  const endSample = Math.floor(viewEnd * data.length);
  const samplesPerPx = Math.max(1, Math.floor((endSample - startSample) / width));

  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const base = startSample + Math.floor(x * (endSample - startSample) / width);
    let min = 1, max = -1;
    for (let j = 0; j < samplesPerPx; j++) {
      const s = data[base + j] ?? 0;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const yMax = ((1 - max) / 2) * height;
    const yMin = ((1 - min) / 2) * height;
    if (x === 0) ctx.moveTo(x, yMax);
    ctx.lineTo(x, yMax);
    ctx.lineTo(x, yMin);
  }
  ctx.stroke();

  const duration = srcBuffer.duration;
  elWaveformTime.textContent = `${formatTime(viewStart * duration)} – ${formatTime(viewEnd * duration)}`;
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

// Waveform / spectrogram interaction

function handleWheel(event) {
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const pivot = (event.clientX - rect.left) / rect.width;
  const factor = event.deltaY > 0 ? 1.25 : 0.8;
  zoomAround(pivot, factor);
}

function zoomAround(pivot, factor) {
  const range = viewEnd - viewStart;
  const newRange = Math.max(0.0005, Math.min(1, range * factor));
  const center = viewStart + pivot * range;
  let newStart = center - pivot * newRange;
  let newEnd = center + (1 - pivot) * newRange;
  if (newStart < 0) { newEnd -= newStart; newStart = 0; }
  if (newEnd > 1) { newStart -= newEnd - 1; newEnd = 1; }
  viewStart = Math.max(0, newStart);
  viewEnd = Math.min(1, newEnd);
  drawWaveform();
  drawSpectrogram();
  updateScrollbar();
}

function resetZoom() {
  viewStart = 0;
  viewEnd = 1;
  drawWaveform();
  drawSpectrogram();
  updateScrollbar();
}

function handleMouseDown(event) {
  if (event.shiftKey) {
    isSelecting = true;
    const rect = elWaveformCanvas.getBoundingClientRect();
    const pos = (event.clientX - rect.left) / rect.width;
    selAnchor = viewStart + pos * (viewEnd - viewStart);
    selStart = selAnchor;
    selEnd = selAnchor;
    elWaveformCanvas.style.cursor = 'crosshair';
  } else {
    isDragging = true;
    dragStartX = event.clientX;
    dragStartViewStart = viewStart;
    dragStartViewEnd = viewEnd;
    elWaveformCanvas.style.cursor = 'grabbing';
  }
}

function handleScrollbarMouseDown(event) {
  const rect = elScrollbar.getBoundingClientRect();
  const pos = (event.clientX - rect.left) / rect.width;
  const thumbLeft = viewStart;
  const thumbRight = viewEnd;

  if (pos >= thumbLeft && pos <= thumbRight) {
    isScrollbarDragging = true;
    scrollbarDragStartX = event.clientX;
    scrollbarDragStartViewStart = viewStart;
    scrollbarDragStartViewEnd = viewEnd;
  } else {
    const range = viewEnd - viewStart;
    viewStart = Math.max(0, Math.min(1 - range, pos - range / 2));
    viewEnd = viewStart + range;
    drawWaveform();
    drawSpectrogram();
    updateScrollbar();
  }
}

function handleMouseMove(event) {
  if (isSelecting) {
    const rect = elWaveformCanvas.getBoundingClientRect();
    const pos = (event.clientX - rect.left) / rect.width;
    const t = Math.max(0, Math.min(1, viewStart + pos * (viewEnd - viewStart)));
    selStart = Math.min(selAnchor, t);
    selEnd = Math.max(selAnchor, t);
    drawWaveform();
    updateSelectionInfo();
    return;
  }
  if (isScrollbarDragging) {
    const rect = elScrollbar.getBoundingClientRect();
    const dx = (event.clientX - scrollbarDragStartX) / rect.width;
    const range = scrollbarDragStartViewEnd - scrollbarDragStartViewStart;
    viewStart = Math.max(0, Math.min(1 - range, scrollbarDragStartViewStart + dx));
    viewEnd = viewStart + range;
    drawWaveform();
    drawSpectrogram();
    updateScrollbar();
    return;
  }
  if (isDragging) {
    const rect = elWaveformCanvas.getBoundingClientRect();
    const dNorm = -(event.clientX - dragStartX) / rect.width * (dragStartViewEnd - dragStartViewStart);
    let newStart = dragStartViewStart + dNorm;
    let newEnd = dragStartViewEnd + dNorm;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > 1) { newStart -= newEnd - 1; newEnd = 1; }
    viewStart = Math.max(0, newStart);
    viewEnd = Math.min(1, newEnd);
    drawWaveform();
    drawSpectrogram();
    updateScrollbar();
  }
}

function handleMouseUp() {
  if (isSelecting) {
    isSelecting = false;
    elWaveformCanvas.style.cursor = '';
    if (selEnd - selStart < 0.001) {
      selStart = null;
      selEnd = null;
      updateSelectionInfo();
      drawWaveform();
    }
  }
  isDragging = false;
  isScrollbarDragging = false;
  if (!isSelecting) elWaveformCanvas.style.cursor = '';
}

// Scrollbar

function updateScrollbar() {
  elScrollThumb.style.left = (viewStart * 100) + '%';
  elScrollThumb.style.width = ((viewEnd - viewStart) * 100) + '%';
}

// Selection

function updateSelectionInfo() {
  if (selStart === null || selEnd === null) {
    elSelectionInfo.classList.add('d-none');
    return;
  }
  const duration = srcBuffer ? srcBuffer.duration : 0;
  elSelectionTimeLabel.textContent = `${formatTime(selStart * duration)} – ${formatTime(selEnd * duration)}`;
  elSelectionInfo.classList.remove('d-none');
}

function clearSelection() {
  selStart = null;
  selEnd = null;
  updateSelectionInfo();
  if (srcBuffer) drawWaveform();
}

// Spectrogram computation

async function computeSpectrogram() {
  const data = srcBuffer.getChannelData(0);
  const numBins = FFT_SIZE / 2;
  specMags = new Float32Array(SPEC_COLS * numBins);
  specMaxMag = 0;

  const chunkSize = 64;
  for (let col = 0; col < SPEC_COLS; col += chunkSize) {
    await new Promise(resolve => setTimeout(resolve, 0));
    const end = Math.min(col + chunkSize, SPEC_COLS);
    for (let c = col; c < end; c++) {
      const center = Math.round((c + 0.5) * data.length / SPEC_COLS);
      const start = Math.max(0, center - FFT_SIZE / 2);
      const signal = new Float32Array(FFT_SIZE);
      const avail = Math.min(FFT_SIZE, data.length - start);
      for (let i = 0; i < avail; i++) signal[i] = data[start + i];
      const mags = fft(signal);
      const off = c * numBins;
      for (let b = 0; b < numBins; b++) {
        specMags[off + b] = mags[b];
        if (mags[b] > specMaxMag) specMaxMag = mags[b];
      }
    }
    elSpectrogramProgress.textContent = `Analyzing… ${Math.round(end / SPEC_COLS * 100)}%`;
  }
}

function fft(signal) {
  const n = FFT_SIZE;
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    re[i] = signal[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  }

  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }

  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / n;
  }
  return mags;
}

// Spectrogram drawing

function drawSpectrogram() {
  if (!specMags || !srcBuffer) return;
  const canvas = elSpectrogramCanvas;
  canvas.width = canvas.clientWidth || 800;
  canvas.height = canvas.clientHeight || 220;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const sampleRate = srcBuffer.sampleRate;
  const numBins = FFT_SIZE / 2;

  const startCol = Math.floor(viewStart * SPEC_COLS);
  const endCol = Math.floor(viewEnd * SPEC_COLS);
  const numViewCols = Math.max(1, endCol - startCol);

  const imageData = ctx.createImageData(width, height);
  for (let px = 0; px < width; px++) {
    const col = Math.max(0, Math.min(SPEC_COLS - 1, startCol + Math.round(px * numViewCols / width)));
    const off = col * numBins;
    for (let py = 0; py < height; py++) {
      const bin = Math.round(yToHz(py, height, sampleRate) * FFT_SIZE / sampleRate);
      if (bin < 0 || bin >= numBins) continue;
      const mag = specMags[off + bin];
      const t = specMaxMag > 0 ? mag / specMaxMag : 0;
      const db = t > 0 ? Math.max(0, 1 + Math.log10(t) / 3) : 0;
      const [r, g, b] = spectrogramColor(db);
      const idx = (py * width + px) * 4;
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  drawSpectrogramLabels(ctx, width, height, sampleRate);
}

function drawSpectrogramLabels(ctx, width, height, sampleRate) {
  const freqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';

  for (const freq of freqs) {
    if (freq >= sampleRate / 2) continue;
    const y = hzToY(freq, height, sampleRate);
    if (y < 8 || y > height - 4) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : `${freq}`, 4, y - 2);
  }

  for (const { freq, type } of filters) {
    const y = hzToY(freq, height, sampleRate);
    if (y < 0 || y > height) continue;
    const isHighpass = type === 'highpass';
    const isLowpass = type === 'lowpass';
    const color = isHighpass ? 'rgba(80,180,255,0.9)' : isLowpass ? 'rgba(255,160,50,0.9)' : 'rgba(255,80,80,0.9)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(isHighpass || isLowpass ? [] : [4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(width, y);
    ctx.stroke();
    if (isHighpass) {
      ctx.fillStyle = color;
      ctx.fillRect(0, y, width, height - y);
    } else if (isLowpass) {
      ctx.fillStyle = color.replace('0.9', '0.07');
      ctx.fillRect(0, 0, width, y);
    }
    ctx.fillStyle = color;
    ctx.fillText(filterLabel({ freq, q: 0, type }), 4, y - 2);
  }
  ctx.setLineDash([]);
}

function yToHz(y, height, sampleRate) {
  const minHz = 20;
  const maxHz = sampleRate / 2;
  return minHz * Math.pow(maxHz / minHz, 1 - y / height);
}

function hzToY(hz, height, sampleRate) {
  const minHz = 20;
  const maxHz = sampleRate / 2;
  if (hz <= minHz) return height;
  if (hz >= maxHz) return 0;
  return Math.round((1 - Math.log(hz / minHz) / Math.log(maxHz / minHz)) * height);
}

function spectrogramColor(t) {
  if (t < 0.25) { const s = t / 0.25; return [0, 0, Math.round(255 * s)]; }
  if (t < 0.5) { const s = (t - 0.25) / 0.25; return [0, Math.round(255 * s), 255]; }
  if (t < 0.75) { const s = (t - 0.5) / 0.25; return [Math.round(255 * s), 255, Math.round(255 * (1 - s))]; }
  const s = (t - 0.75) / 0.25;
  return [255, Math.round(255 * (1 - s)), 0];
}

function handleSpectrogramClick(event) {
  if (!srcBuffer) return;
  const rect = elSpectrogramCanvas.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const freq = Math.max(1, Math.min(22000, Math.round(yToHz(y, rect.height, srcBuffer.sampleRate))));
  const q = parseFloat(elFilterQ.value) || 30;
  const type = elFilterType.value;
  elFilterFreq.value = freq;
  addFilter(freq, q, type);
}

// Band detection

function detectBands() {
  if (!specMags || !srcBuffer) return [];
  const numBins = FFT_SIZE / 2;
  const sampleRate = srcBuffer.sampleRate;
  const threshold = specMaxMag * 0.15;

  const avgMagPerBin = new Float32Array(numBins);
  const persistence = new Float32Array(numBins);

  for (let bin = 0; bin < numBins; bin++) {
    let sum = 0, count = 0;
    for (let col = 0; col < SPEC_COLS; col++) {
      const mag = specMags[col * numBins + bin];
      sum += mag;
      if (mag > threshold) count++;
    }
    avgMagPerBin[bin] = sum / SPEC_COLS;
    persistence[bin] = count / SPEC_COLS;
  }

  const candidates = [];
  for (let bin = 3; bin < numBins - 3; bin++) {
    if (persistence[bin] < 0.35) continue;
    const score = persistence[bin] * avgMagPerBin[bin];
    let isMax = true;
    for (let k = bin - 3; k <= bin + 3; k++) {
      if (k !== bin && persistence[k] * avgMagPerBin[k] >= score) { isMax = false; break; }
    }
    if (!isMax) continue;

    // Tonality: must stand out from surrounding bins
    let surroundSum = 0, surroundCount = 0;
    for (let k = Math.max(0, bin - 20); k <= Math.min(numBins - 1, bin + 20); k++) {
      if (Math.abs(k - bin) > 3) { surroundSum += avgMagPerBin[k]; surroundCount++; }
    }
    const surroundAvg = surroundCount > 0 ? surroundSum / surroundCount : 0;
    if (avgMagPerBin[bin] < surroundAvg * 1.8) continue;

    const freq = Math.round(bin * sampleRate / FFT_SIZE);
    if (freq < 20) continue;
    candidates.push({ freq, persistence: persistence[bin], score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8);
}

function renderDetectionResults(bands) {
  if (!bands || bands.length === 0) {
    elDetectionList.innerHTML = '<span class="text-body-secondary small">No persistent tonal frequencies detected in this file.</span>';
  } else {
    const count = bands.length;
    elDetectionList.innerHTML =
      `<span class="small text-body-secondary me-1">${count} filter${count !== 1 ? 's' : ''} added:</span>` +
      bands.map(b =>
        `<span class="badge bg-success-subtle text-success-emphasis border border-success-subtle">${b.freq} Hz <span class="opacity-75">${Math.round(b.persistence * 100)}%</span></span>`
      ).join('');
  }
  elDetectionResults.classList.remove('d-none');
}

// Filters

function addFilter(freq, q, type = 'notch') {
  if (filters.some(f => f.freq === freq && f.type === type)) return;
  filters.push({ freq, q, type });
  saveHistory();
  renderFilterList();
  drawSpectrogram();
  restartPreview();
}

function removeFilter(idx) {
  filters.splice(idx, 1);
  saveHistory();
  renderFilterList();
  drawSpectrogram();
  restartPreview();
}

function filterLabel(f) {
  const hz = f.freq >= 1000 ? `${f.freq / 1000 % 1 === 0 ? f.freq / 1000 : (f.freq / 1000).toFixed(1)}k` : f.freq;
  if (f.type === 'highpass') return `highpass ${hz} Hz`;
  if (f.type === 'lowpass') return `lowpass ${hz} Hz`;
  return `notch ${hz} Hz (Q: ${f.q})`;
}

function renderFilterList() {
  if (filters.length === 0) {
    elFilterList.innerHTML = '<span class="text-body-secondary small">No filters added yet.</span>';
    return;
  }
  elFilterList.innerHTML = filters.map((f, i) =>
    `<span class="badge bg-secondary d-inline-flex align-items-center gap-1" style="font-size:.85em">
      ${filterLabel(f)}
      <button type="button" class="btn-close btn-close-white ms-1" style="font-size:.55em" aria-label="Remove filter" data-idx="${i}"></button>
    </span>`
  ).join('');
  elFilterList.querySelectorAll('.btn-close').forEach(btn => {
    btn.addEventListener('click', () => removeFilter(parseInt(btn.dataset.idx)));
  });
}

// History

function saveHistory() {
  history = history.slice(0, historyIndex + 1);
  history.push(filters.map(f => ({ ...f })));
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  filters = history[historyIndex].map(f => ({ ...f }));
  renderFilterList();
  drawSpectrogram();
  updateUndoRedoButtons();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  filters = history[historyIndex].map(f => ({ ...f }));
  renderFilterList();
  drawSpectrogram();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  elBtnUndo.disabled = historyIndex <= 0;
  elBtnRedo.disabled = historyIndex >= history.length - 1;
}

// Audio processing

function buildFilterGraph(ctx, source) {
  let node = source;
  for (const { freq, q, type } of filters) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = type || 'notch';
    biquad.frequency.value = freq;
    biquad.Q.value = q;
    node.connect(biquad);
    node = biquad;
  }
  return node;
}

async function applyFilters() {
  if (!srcBuffer) return null;
  if (filters.length === 0) return srcBuffer;
  const offCtx = new OfflineAudioContext(
    srcBuffer.numberOfChannels,
    srcBuffer.length,
    srcBuffer.sampleRate
  );
  const source = offCtx.createBufferSource();
  source.buffer = srcBuffer;
  buildFilterGraph(offCtx, source).connect(offCtx.destination);
  source.start();
  return offCtx.startRendering();
}

async function applyFiltersWithSelection() {
  if (!srcBuffer) return null;
  if (filters.length === 0) return srcBuffer;
  if (selStart === null || selEnd === null) return applyFilters();

  const buf = srcBuffer;
  const filtered = await applyFilters();
  const startSample = Math.round(selStart * buf.length);
  const endSample = Math.round(selEnd * buf.length);
  const numChannels = buf.numberOfChannels;

  const output = new AudioBuffer({
    numberOfChannels: numChannels,
    length: buf.length,
    sampleRate: buf.sampleRate,
  });

  for (let ch = 0; ch < numChannels; ch++) {
    const orig = buf.getChannelData(ch);
    const filt = filtered.getChannelData(ch);
    const out = output.getChannelData(ch);
    for (let i = 0; i < buf.length; i++) {
      out[i] = (i >= startSample && i < endSample) ? filt[i] : orig[i];
    }
  }
  return output;
}

// Preview

function startPreview(offsetOverride) {
  stopPreview();
  if (!srcBuffer) return;

  // Create the context synchronously inside this click handler so the browser
  // always treats it as user-gesture-activated (avoids autoplay suspension).
  playbackCtx = new AudioContext();

  const source = playbackCtx.createBufferSource();
  source.buffer = srcBuffer;
  buildFilterGraph(playbackCtx, source).connect(playbackCtx.destination);

  const offset = (typeof offsetOverride === 'number' && isFinite(offsetOverride))
    ? offsetOverride
    : (selStart !== null ? selStart * srcBuffer.duration : viewStart * srcBuffer.duration);

  previewOffsetAtStart = offset;

  // Only pass duration when there is an active selection; passing undefined
  // explicitly causes some browsers to convert it to NaN and play nothing.
  if (selStart !== null && offsetOverride === undefined) {
    source.start(0, offset, (selEnd - selStart) * srcBuffer.duration);
  } else {
    source.start(0, offset);
  }

  previewSource = source;
  elBtnPreview.classList.add('d-none');
  elBtnStop.classList.remove('d-none');

  source.onended = () => {
    playbackCtx?.close();
    playbackCtx = null;
    previewSource = null;
    elBtnPreview.classList.remove('d-none');
    elBtnStop.classList.add('d-none');
  };
}

function restartPreview() {
  if (!previewSource) return;
  const position = previewOffsetAtStart + (playbackCtx?.currentTime ?? 0);
  startPreview(Math.min(position, srcBuffer.duration - 0.01));
}

function stopPreview() {
  if (!previewSource) return;
  previewSource.onended = null;
  try { previewSource.stop(); } catch (_) {}
  previewSource = null;
  playbackCtx?.close();
  playbackCtx = null;
  elBtnPreview.classList.remove('d-none');
  elBtnStop.classList.add('d-none');
}

// Export

async function exportAudio() {
  if (!srcBuffer) return;
  const format = elExportFormat.value;

  if (format === 'mp3' && typeof lamejs === 'undefined') {
    alert('MP3 encoder failed to load. Please check your internet connection, or use WAV export.');
    return;
  }

  elBtnExport.disabled = true;
  elBtnExport.textContent = 'Processing…';

  try {
    const rendered = await applyFiltersWithSelection();
    const baseName = elFileName.textContent.replace(/\.[^.]+$/, '') || 'output';
    let blob, ext;

    if (format === 'mp3') {
      blob = encodeMp3(rendered);
      ext = 'mp3';
    } else {
      blob = encodeWAV(rendered);
      ext = 'wav';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}-filtered.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  } finally {
    elBtnExport.disabled = false;
    elBtnExport.textContent = 'Export';
  }
}

function encodeWAV(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const blockAlign = numChannels * 2;
  const dataSize = numSamples * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function encodeMp3(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, 128);

  const toInt16 = (f32) => {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return i16;
  };

  const left = toInt16(buffer.getChannelData(0));
  const right = numChannels > 1 ? toInt16(buffer.getChannelData(1)) : left;
  const chunkSize = 1152;
  const chunks = [];

  for (let i = 0; i < left.length; i += chunkSize) {
    const encoded = numChannels > 1
      ? encoder.encodeBuffer(left.subarray(i, i + chunkSize), right.subarray(i, i + chunkSize))
      : encoder.encodeBuffer(left.subarray(i, i + chunkSize));
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) chunks.push(new Uint8Array(flushed));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }

  return new Blob([result], { type: 'audio/mpeg' });
}
