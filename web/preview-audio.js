// Web Audio helpers for safe, per-track auditioning.
export const PREVIEW_VOLUME_MIN = -60;
export const PREVIEW_VOLUME_MAX = 12;

let previewAudioContext = null;
const previewAudioGraphs = new WeakMap();

function previewGraph(audio) {
  if (previewAudioGraphs.has(audio)) return previewAudioGraphs.get(audio);
  try {
    previewAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    const source = previewAudioContext.createMediaElementSource(audio);
    const gain = previewAudioContext.createGain();
    const limiter = previewAudioContext.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    source.connect(gain).connect(limiter).connect(previewAudioContext.destination);
    const graph = { gain, limiter };
    previewAudioGraphs.set(audio, graph);
    return graph;
  } catch (_) {
    return null;
  }
}

export function applyPreviewAudioSettings(row, limiterCheckbox) {
  const audio = row.querySelector(".track-preview-audio");
  const graph = audio && previewGraph(audio);
  if (!graph) return;
  const muted = row.dataset.previewMuted === "true";
  const volume = Number(row.querySelector(".track-preview-volume input[type=range]")?.value) || 0;
  graph.gain.gain.value = muted ? 0 : Math.pow(10, volume / 20);
  const enabled = limiterCheckbox?.checked ?? true;
  graph.limiter.threshold.value = enabled ? -1 : 0;
  graph.limiter.ratio.value = enabled ? 20 : 1;
  graph.limiter.knee.value = enabled ? 0 : 30;
}

export function resumePreviewAudio() {
  return previewAudioContext?.resume();
}
