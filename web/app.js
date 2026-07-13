import { $, api } from "./core.js";
import { changeLanguage, currentLanguage, initializeLanguage, t } from "./i18n.js";
import { refreshStatus, watch } from "./jobs.js";
import { levelOptionState } from "./level-options.js";
import { applyPreviewAudioSettings, PREVIEW_VOLUME_MAX, PREVIEW_VOLUME_MIN, resumePreviewAudio } from "./preview-audio.js";
import { displayTimeLimit, normalizeTrimRange, timeAtPointer } from "./trim-geometry.js";

const ZIP_PREFERENCE_KEY = "packageZip";
const OPEN_FINDER_PREFERENCE_KEY = "openFinderOnComplete";
const SPLIT_STEREO_PREFERENCE_KEY = "splitStereo";
const PREVIEW_LIMITER_PREFERENCE_KEY = "previewLimiter";
let selectingFolder = false;

let waveformTracks = [];
let waveformDuration = 0;
let globalMarkerDrag = null;
let playbackDrag = null;
let lastPreviewRow = null;
let allPreviewPlaying = false;
let syncingSharedPlayback = false;
function resetWaveformState() {
  document.querySelectorAll(".track-preview-audio").forEach((audio) => audio.pause());
  waveformTracks = [];
  waveformDuration = 0;
  globalMarkerDrag = null;
  playbackDrag = null;
  lastPreviewRow = null;
  allPreviewPlaying = false;
  syncingSharedPlayback = false;
  $("#waveforms").innerHTML = "";
  $("#preview-volume-toolbar").classList.add("hidden");
  $("#playhead-mode-option").classList.add("hidden");
  $("#linked-playheads").checked = true;
  $("#independent-playheads").checked = false;
  $("#waveform-status").textContent = "";
  $("#waveform-status").classList.remove("waveform-log");
  $("#trim-controls").classList.add("hidden");
  $("#trim-controls").classList.remove("has-preview-volume");
  $("#individual-trim-option").classList.add("hidden");
  $("#individual-trim").checked = false;
  $("#unified-trim").checked = true;
  $("#auto-deselect-silent-option").classList.add("hidden");
  $("#select-all").classList.add("hidden");
  $("#select-none").classList.add("hidden");
  $("#trim-start").value = "0";
  $("#trim-end").value = "";
  $("#trim-start-range").value = "0";
  $("#trim-end-range").value = "0";
  $("#trim-fill").style.left = "0%";
  $("#trim-fill").style.width = "0%";
  updateLevelOptions();
}

function updateOutputFormat() {
  const format = $("#output-format").value;
  $("#bitrate-field").classList.toggle("hidden", format === "wav");
  $("#wav-depth-field").classList.toggle("hidden", format !== "wav");
  $("#bitrate-label").textContent = t(format === "m4a" ? "aacBitrate" : "bitrate");
}

function updateLevelOptions() {
  const mode = document.querySelector("input[name=mode]:checked")?.value;
  const safety = $("#enforce-safety");
  const previewGain = $("#apply-preview-gain");
  if (!safety || !previewGain) return;
  const state = levelOptionState(mode, waveformTracks.length > 0);
  safety.disabled = state.safetyDisabled;
  previewGain.disabled = state.previewGainDisabled;
  if (state.previewGainDisabled) previewGain.checked = false;
}

function syncTrim(changed = "") {
  if (!waveformDuration) return;
  const { start, end } = normalizeTrimRange($("#trim-start").value, $("#trim-end").value || waveformDuration, waveformDuration, changed);
  $("#trim-start").value = start.toFixed(3);
  $("#trim-end").value = end.toFixed(3);
  $("#trim-start-range").value = start;
  $("#trim-end-range").value = end;
  $("#trim-fill").style.left = `${start / waveformDuration * 100}%`;
  $("#trim-fill").style.width = `${(end - start) / waveformDuration * 100}%`;
  document.querySelectorAll(".wave-track:not(.individual-trim-active)").forEach((row) => syncSharedOverlay(row, start, end));
  reconcileTrackPreviews();
}

function syncSharedOverlay(row, start, end) {
  const overlay = row.querySelector(".trim-range-overlay");
  const waveform = row.querySelector(".wave-image");
  if (!overlay || !waveform) return;
  const rowBounds = row.getBoundingClientRect();
  const waveformBounds = waveform.getBoundingClientRect();
  const duration = Number(row.dataset.duration) || waveformDuration;
  if (!duration || !waveformBounds.width || !rowBounds.width) return;
  const left = waveformBounds.left - rowBounds.left + start / duration * waveformBounds.width;
  const right = rowBounds.right - waveformBounds.right + (1 - end / duration) * waveformBounds.width;
  overlay.style.top = `${waveformBounds.top - rowBounds.top}px`;
  overlay.style.bottom = `${rowBounds.bottom - waveformBounds.bottom}px`;
  overlay.style.left = `${left}px`;
  overlay.style.right = `${Math.max(0, right)}px`;
}

function setSharedTrimFromMarker(row, marker, clientX) {
  lastPreviewRow = row;
  const waveform = row.querySelector(".wave-image");
  const bounds = waveform.getBoundingClientRect();
  const duration = Number(row.dataset.duration) || waveformDuration;
  if (!bounds.width || !duration) return;
  const time = timeAtPointer(clientX, bounds, duration);
  const isStart = marker.dataset.marker === "start";
  $(isStart ? "#trim-start" : "#trim-end").value = time;
  syncTrim(isStart ? "start" : "end");
}

function setIndividualTrimFromMarker(row, marker, clientX) {
  lastPreviewRow = row;
  const waveform = row.querySelector(".wave-image");
  const bounds = waveform.getBoundingClientRect();
  const duration = Number(row.dataset.duration);
  if (!bounds.width || !duration) return;
  const time = timeAtPointer(clientX, bounds, duration);
  row.querySelector(marker.dataset.marker === "start" ? ".track-trim-start" : ".track-trim-end").value = time;
  syncIndividualTrim(row);
}

function dragSharedMarker(event) {
  if (!globalMarkerDrag) return;
  event.preventDefault();
  if (globalMarkerDrag.individual) setIndividualTrimFromMarker(globalMarkerDrag.row, globalMarkerDrag.marker, event.clientX);
  else setSharedTrimFromMarker(globalMarkerDrag.row, globalMarkerDrag.marker, event.clientX);
}

function endSharedMarkerDrag() {
  globalMarkerDrag = null;
}

function seekPlaybackFromPointer(row, clientX) {
  const audio = row.querySelector(".track-preview-audio");
  const overlay = row.querySelector(".trim-range-overlay");
  if (!audio || !overlay) return;
  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width) return;
  const { start, end } = previewBounds(row);
  const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
  audio.currentTime = start + ratio * (end - start);
  audio.dataset.previewPosition = String(audio.currentTime);
  row.querySelector(".playback-marker")?.classList.remove("hidden");
  updatePlaybackMarker(row);
  syncSharedPlaybackPosition(row, audio.currentTime);
}

function syncSharedPlaybackPosition(sourceRow, time) {
  if (syncingSharedPlayback || !$("#linked-playheads").checked) return;
  const rows = previewRows();
  if (!rows.length) return;
  syncingSharedPlayback = true;
  rows.forEach((row) => {
    if (row === sourceRow) return;
    const audio = row.querySelector(".track-preview-audio");
    if (!audio) return;
    const bounds = previewBounds(row);
    const target = Math.max(bounds.start, Math.min(bounds.end, time));
    if (Math.abs((audio.currentTime || 0) - target) > 0.01) audio.currentTime = target;
    audio.dataset.previewPosition = String(target);
    row.querySelector(".playback-marker")?.classList.remove("hidden");
    updatePlaybackMarker(row);
  });
  syncingSharedPlayback = false;
}

function beginPlaybackDrag(event) {
  const marker = event.target.closest(".playback-marker");
  if (!marker || event.button !== 0) return;
  const row = marker.closest(".wave-track");
  const audio = row?.querySelector(".track-preview-audio");
  if (!row || row.classList.contains("is-deselected") || !audio || audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
  event.preventDefault();
  lastPreviewRow = row;
  playbackDrag = { row };
  if (event.pointerId !== undefined) marker.setPointerCapture?.(event.pointerId);
  seekPlaybackFromPointer(row, event.clientX);
}

function dragPlayback(event) {
  if (!playbackDrag) return;
  event.preventDefault();
  seekPlaybackFromPointer(playbackDrag.row, event.clientX);
}

function endPlaybackDrag() {
  playbackDrag = null;
}

function syncIndividualTrim(row) {
  const duration = Number(row.dataset.duration);
  const { start, end } = normalizeTrimRange(row.querySelector(".track-trim-start").value, row.querySelector(".track-trim-end").value || duration, duration);
  row.querySelector(".track-trim-start").value = start.toFixed(3);
  row.querySelector(".track-trim-end").value = end.toFixed(3);
  row.querySelector(".track-trim-start-range").value = start;
  row.querySelector(".track-trim-end-range").value = end;
  const fill = row.querySelector(".track-range-fill");
  syncIndividualOverlay(row, start, end, fill);
  reconcileTrackPreviews(row);
}

function syncIndividualOverlay(row, start, end, fill = row.querySelector(".track-range-fill")) {
  const duration = Number(row.dataset.duration);
  const overlay = row.querySelector(".trim-range-overlay");
  const rowBounds = row.getBoundingClientRect();
  const waveform = row.querySelector(".wave-image");
  const waveformBounds = waveform.getBoundingClientRect();
  const trackBounds = row.querySelector(".track-range-controls").getBoundingClientRect();
  // The waveform is nested in a wrapper, so offsetTop is relative to that
  // wrapper rather than the track. Use viewport rectangles to keep the trim
  // overlay exactly within the waveform and away from the controls above it.
  overlay.style.top = `${waveformBounds.top - rowBounds.top}px`;
  overlay.style.bottom = `${rowBounds.bottom - waveformBounds.bottom}px`;
  if (!waveformBounds.width || !rowBounds.width) {
    overlay.style.left = `${start / duration * 100}%`;
    overlay.style.right = `${Math.max(0, 100 - end / duration * 100)}%`;
    fill.style.left = `${start / duration * 100}%`;
    fill.style.width = `${(end - start) / duration * 100}%`;
    return;
  }
  // The waveform image is the source of truth: its borders must always mark
  // 0% and 100% so the visual trim range accurately covers the audio preview.
  const waveformStart = waveformBounds.left - rowBounds.left;
  const left = waveformStart + start / duration * waveformBounds.width;
  const endPosition = waveformStart + end / duration * waveformBounds.width;
  const fillStart = waveformBounds.left - trackBounds.left + start / duration * waveformBounds.width;
  const fillEnd = waveformBounds.left - trackBounds.left + end / duration * waveformBounds.width;
  const right = rowBounds.width - endPosition;
  fill.style.left = `${fillStart}px`;
  fill.style.width = `${Math.max(0, fillEnd - fillStart)}px`;
  overlay.style.left = `${left}px`;
  overlay.style.right = `${Math.max(0, right)}px`;
}

function updateIndividualTrimMode() {
  const enabled = $("#individual-trim").checked;
  $("#trim-controls").classList.toggle("is-disabled", enabled);
  ["#trim-start", "#trim-end", "#trim-start-range", "#trim-end-range"].forEach((selector) => { $(selector).disabled = enabled; });
  document.querySelectorAll(".wave-track").forEach((row) => {
    row.classList.toggle("individual-trim-active", enabled);
    row.querySelector(".track-trim-controls").classList.toggle("hidden", !enabled);
    updateTrackSelectionState(row);
    if (enabled) syncIndividualTrim(row);
  });
  if (!enabled) syncTrim();
}

function updateTrackSelectionState(row) {
  const selected = row.querySelector("input[name=selectedFiles]").checked;
  const individualTrimEnabled = $("#individual-trim").checked;
  row.classList.toggle("is-deselected", !selected);
  row.querySelectorAll(".track-trim-start, .track-trim-end, .track-trim-start-range, .track-trim-end-range").forEach((input) => {
    input.disabled = !selected || !individualTrimEnabled;
  });
  const preview = row.querySelector(".track-preview-button");
  if (preview) preview.disabled = !selected;
  if (!selected) {
    stopTrackPreview(row, true);
    row.querySelector(".playback-marker")?.classList.add("hidden");
  }
}

function previewBounds(row) {
  const duration = Number(row.dataset.duration);
  if ($("#individual-trim").checked) {
    return {
      start: Number(row.querySelector(".track-trim-start").value) || 0,
      end: Number(row.querySelector(".track-trim-end").value) || duration,
    };
  }
  return { start: Number($("#trim-start").value) || 0, end: Math.min(Number($("#trim-end").value) || duration, duration) };
}

function setPreviewButton(row, playing) {
  const button = row.querySelector(".track-preview-button");
  if (!button) return;
  button.classList.toggle("is-playing", playing);
  button.textContent = playing ? t("previewPause") : t("previewPlay");
}

function updatePlaybackMarker(row) {
  const audio = row.querySelector(".track-preview-audio");
  const marker = row.querySelector(".playback-marker");
  if (!audio || !marker) return;
  const { start, end } = previewBounds(row);
  const percent = end > start ? (audio.currentTime - start) / (end - start) * 100 : 0;
  marker.style.left = `${Math.max(0, Math.min(100, percent))}%`;
}

function reconcileTrackPreviews(changedRow = null) {
  document.querySelectorAll(".wave-track").forEach((row) => {
    if (changedRow && row !== changedRow && $("#individual-trim").checked) return;
    const audio = row.querySelector(".track-preview-audio");
    const marker = row.querySelector(".playback-marker");
    if (!audio || audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
    const { start, end } = previewBounds(row);
    const outOfBounds = audio.currentTime < start || audio.currentTime >= end;
    if (!outOfBounds) {
      // Keep the playhead at the same absolute audio time while a paused trim
      // range moves around it; only its relative position inside the range changes.
      if (!audio.paused || !marker?.classList.contains("hidden")) updatePlaybackMarker(row);
      return;
    }
    // A newly moved trim boundary must never leave an old audio position playing
    // beyond the highlighted range. While paused, move only when the playhead
    // would fall outside the new range; otherwise leave it at its exact time.
    if (!audio.paused) {
      const boundary = audio.currentTime < start ? start : end;
      stopTrackPreview(row, true, boundary);
    }
    else if (!marker?.classList.contains("hidden")) {
      audio.currentTime = audio.currentTime < start ? start : end;
      audio.dataset.previewPosition = String(audio.currentTime);
      updatePlaybackMarker(row);
    }
  });
}

function stopTrackPreview(row, reset = false, resetPosition = null) {
  const audio = row.querySelector(".track-preview-audio");
  if (!audio) return;
  audio.pause();
  if (reset && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    const bounds = previewBounds(row);
    const target = Number.isFinite(resetPosition)
      ? Math.max(bounds.start, Math.min(bounds.end, resetPosition))
      : bounds.start;
    audio.currentTime = target;
    audio.dataset.previewPosition = String(audio.currentTime);
    row.querySelector(".playback-marker")?.classList.remove("hidden");
  }
  setPreviewButton(row, false);
}

function startTrackPreview(row) {
  const audio = row.querySelector(".track-preview-audio");
  if (!audio) return;
  allPreviewPlaying = false;
  document.querySelectorAll(".wave-track").forEach((other) => { if (other !== row) stopTrackPreview(other); });
  const bounds = previewBounds(row);
  const savedPosition = Number(audio.dataset.previewPosition);
  const start = Number.isFinite(savedPosition) && savedPosition >= bounds.start && savedPosition < bounds.end
    ? savedPosition : bounds.start;
  const play = () => {
    applyPreviewAudioSettings(row, $("#preview-limiter"));
    resumePreviewAudio();
    audio.currentTime = start;
    audio.play().then(() => {
      setPreviewButton(row, true);
      row.querySelector(".playback-marker")?.classList.remove("hidden");
      updatePlaybackMarker(row);
    }).catch(() => {
      setPreviewButton(row, false);
      alert(t("previewUnavailable"));
    });
  };
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) play();
  else {
    audio.addEventListener("loadedmetadata", play, { once:true });
    audio.load();
  }
}

function toggleTrackPreview(row) {
  const audio = row.querySelector(".track-preview-audio");
  if (!audio) return;
  if (audio.paused) startTrackPreview(row);
  else stopTrackPreview(row);
}

function previewRows() {
  return [...document.querySelectorAll(".wave-track")].filter((row) => {
    const selected = row.querySelector("input[name=selectedFiles]")?.checked;
    return selected && !row.classList.contains("is-deselected") && row.querySelector(".track-preview-audio");
  });
}

function syncAllPreviewButton() {
  const button = $("#all-preview-button");
  if (!button) return;
  const playing = allPreviewPlaying && previewRows().some((row) => !row.querySelector(".track-preview-audio").paused);
  button.textContent = t(playing ? "previewPauseAll" : "previewPlayAll");
  button.classList.toggle("is-playing", playing);
  button.dataset.playing = String(playing);
}

function stopAllTrackPreviews() {
  allPreviewPlaying = false;
  document.querySelectorAll(".wave-track").forEach((row) => stopTrackPreview(row));
  syncAllPreviewButton();
}

function resetAllPlayheads() {
  allPreviewPlaying = false;
  document.querySelectorAll(".wave-track").forEach((row) => {
    const audio = row.querySelector(".track-preview-audio");
    if (!audio) return;
    stopTrackPreview(row);
    const bounds = previewBounds(row);
    audio.currentTime = bounds.start;
    audio.dataset.previewPosition = String(bounds.start);
    row.querySelector(".playback-marker")?.classList.remove("hidden");
    updatePlaybackMarker(row);
  });
  syncAllPreviewButton();
}

function startAllTrackPreviews() {
  const rows = previewRows();
  if (!rows.length) return;
  const shared = $("#linked-playheads").checked;
  const reference = lastPreviewRow?.querySelector(".track-preview-audio");
  const referenceBounds = lastPreviewRow ? previewBounds(lastPreviewRow) : null;
  const referencePosition = reference && referenceBounds && Number.isFinite(reference.currentTime)
    && reference.currentTime >= referenceBounds.start && reference.currentTime < referenceBounds.end
    ? reference.currentTime : null;
  const sharedPosition = referencePosition ?? previewBounds(rows[0]).start;
  allPreviewPlaying = true;
  rows.forEach((row) => {
    const audio = row.querySelector(".track-preview-audio");
    const bounds = previewBounds(row);
    const savedPosition = Number(audio.dataset.previewPosition);
    const position = shared
      ? Math.max(bounds.start, Math.min(bounds.end, sharedPosition))
      : (Number.isFinite(savedPosition) && savedPosition >= bounds.start && savedPosition < bounds.end
        ? savedPosition : bounds.start);
    applyPreviewAudioSettings(row, $("#preview-limiter"));
    resumePreviewAudio();
    audio.currentTime = position;
    audio.play().then(() => {
      setPreviewButton(row, true);
      row.querySelector(".playback-marker")?.classList.remove("hidden");
      updatePlaybackMarker(row);
      syncAllPreviewButton();
    }).catch(() => { setPreviewButton(row, false); syncAllPreviewButton(); });
  });
}

function renderWaveforms(preview) {
  waveformTracks = preview;
  waveformDuration = Math.min(...preview.map((track) => track.duration));
  const waves = $("#waveforms");
  waves.innerHTML = preview.map((track) => {
    const trackId = encodeURIComponent(track.name);
    const displayDuration = displayTimeLimit(track.duration);
  const channelGuide = track.stereo ? `<div class="stereo-channel-guide" aria-hidden="true"><span class="stereo-channel-label stereo-channel-label-left">L</span><span class="stereo-channel-label stereo-channel-label-right">R</span><span class="stereo-channel-divider"></span></div>` : "";
    return `<div class="wave-track" data-track="${trackId}" data-duration="${track.duration}"><label class="wave-name track-select"><input type="checkbox" name="selectedFiles" value="${track.name}" checked />${track.name}</label><button class="track-collapse-button secondary" type="button" aria-expanded="true" title="${t("collapseTrack")}">${t("collapseTrack")}</button><button class="track-preview-button secondary" type="button">${t("previewPlay")}</button><audio class="track-preview-audio" preload="metadata" src="${track.audio}"></audio><div class="track-trim-controls hidden"><label>${t("trackStart")}<input class="track-trim-start" type="number" min="0" max="${displayDuration}" step="0.001" value="0" /></label><label>${t("trackEnd")}<input class="track-trim-end" type="number" min="0" max="${displayDuration}" step="0.001" value="${track.duration.toFixed(3)}" /></label><div class="track-range-controls"><div class="track-range-rail"></div><div class="track-range-fill"></div><input class="track-trim-start-range" type="range" min="0" max="${displayDuration}" step="0.001" value="0" /><input class="track-trim-end-range" type="range" min="0" max="${displayDuration}" step="0.001" value="${track.duration.toFixed(3)}" /></div></div><div class="wave-image-wrap"><img class="wave-image" src="${track.image}" alt="${track.name}" />${channelGuide}</div><div class="trim-range-overlay" data-duration="${track.duration}"><span class="playback-marker hidden" aria-hidden="true"></span><span class="trim-marker trim-marker-start" data-marker="start" aria-label="Trim start"></span><span class="trim-marker trim-marker-end" data-marker="end" aria-label="Trim end"></span></div></div>`;
  }).join("");
  document.querySelectorAll(".wave-track").forEach((row) => {
    const volume = document.createElement("label");
    volume.className = "track-preview-volume";
    volume.title = t("previewVolume");
    volume.innerHTML = `<span class="track-preview-volume-icon" aria-hidden="true">🔊</span><input type="range" min="${PREVIEW_VOLUME_MIN}" max="${PREVIEW_VOLUME_MAX}" step="1" value="0" title="${t("previewVolume")}" aria-label="${t("previewVolume")}" /><span class="track-preview-volume-number-row"><input class="track-preview-volume-number" type="number" min="${PREVIEW_VOLUME_MIN}" max="${PREVIEW_VOLUME_MAX}" step="1" value="0" aria-label="${t("previewVolume")}" /><span class="track-preview-volume-unit">dB</span></span>`;
    row.querySelector(".wave-image-wrap").append(volume);
  });
  const displayWaveformDuration = displayTimeLimit(waveformDuration);
  ["#trim-start-range", "#trim-end-range"].forEach((selector) => { $(selector).max = displayWaveformDuration; });
  $("#trim-end").max = displayWaveformDuration;
  $("#trim-controls").classList.remove("hidden");
  $("#trim-controls").classList.add("has-preview-volume");
  $("#preview-volume-toolbar").classList.remove("hidden");
  $("#playhead-mode-option").classList.remove("hidden");
  updateLevelOptions();
  $("#select-all").classList.remove("hidden");
  $("#select-none").classList.remove("hidden");
  $("#trim-end").value = waveformDuration.toFixed(3);
  const uneven = Math.max(...preview.map((track) => track.duration)) - waveformDuration > 0.01;
  $("#individual-trim-option").classList.remove("hidden");
  $("#auto-deselect-silent-option").classList.remove("hidden");
  $("#individual-trim").checked = uneven;
  $("#unified-trim").checked = !uneven;
  updateIndividualTrimMode();
  $("#waveform-status").textContent = t("waveformsReady");
  $("#waveform-status").classList.remove("waveform-log");
  syncTrim();
  document.querySelectorAll(".track-preview-audio").forEach((audio) => {
    const row = audio.closest(".wave-track");
    const volume = row.querySelector(".track-preview-volume input[type=range]");
    const volumeNumber = row.querySelector(".track-preview-volume-number");
    volume.addEventListener("input", () => {
      volumeNumber.value = volume.value;
      applyPreviewAudioSettings(row, $("#preview-limiter"));
    });
    volumeNumber.addEventListener("input", () => {
      volume.value = Math.max(PREVIEW_VOLUME_MIN, Math.min(PREVIEW_VOLUME_MAX, Number(volumeNumber.value) || 0));
      applyPreviewAudioSettings(row, $("#preview-limiter"));
    });
    applyPreviewAudioSettings(row, $("#preview-limiter"));
    audio.addEventListener("timeupdate", () => {
      audio.dataset.previewPosition = String(audio.currentTime);
      if ($("#linked-playheads").checked) syncSharedPlaybackPosition(row, audio.currentTime);
      const bounds = previewBounds(row);
      if (audio.currentTime < bounds.start || audio.currentTime >= bounds.end) {
        const boundary = audio.currentTime < bounds.start ? bounds.start : bounds.end;
        if (allPreviewPlaying && $("#linked-playheads").checked) {
          // In linked mode a shorter track defines the end of the group.
          // Stop every track together instead of leaving longer tracks playing
          // while one audio element sits exactly at its invalid end position.
          stopAllTrackPreviews();
        } else {
          stopTrackPreview(row, true, boundary);
        }
      } else updatePlaybackMarker(row);
    });
    audio.addEventListener("ended", () => {
      setPreviewButton(row, false);
      if (!previewRows().some((item) => !item.querySelector(".track-preview-audio").paused)) allPreviewPlaying = false;
      syncAllPreviewButton();
    });
    audio.addEventListener("error", () => { setPreviewButton(row, false); syncAllPreviewButton(); });
    audio.addEventListener("play", syncAllPreviewButton);
    audio.addEventListener("pause", syncAllPreviewButton);
  });
  syncAllPreviewButton();
}

function autoDeselectSilentTracks() {
  const threshold = Number(document.querySelector("select[name=silenceThreshold]").value);
  waveformTracks.forEach((track) => {
    const row = document.querySelector(`.wave-track[data-track="${encodeURIComponent(track.name)}"]`);
    if (!row) return;
    row.querySelector("input[name=selectedFiles]").checked = track.peak !== null && track.peak !== undefined && Number(track.peak) > threshold;
    updateTrackSelectionState(row);
  });
}

function pollWaveforms(job) {
  const timer = setInterval(async () => {
    const data = await api(`/api/job/${job}`);
    $("#waveform-status").textContent = data.log || t("loadingWaveforms");
    $("#waveform-status").scrollTop = $("#waveform-status").scrollHeight;
    if (data.status !== "running") {
      clearInterval(timer);
      $("#load-waveforms").disabled = false;
      if (data.status === "done") renderWaveforms(data.preview);
      else $("#waveform-status").textContent = data.log || t("error");
    }
  }, 500);
}

$("#convert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#convert-button").disabled = true;
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form);
  payload.language = currentLanguage();
  payload.enforceSafety = $("#enforce-safety").checked;
  payload.applyPreviewGain = $("#apply-preview-gain").checked;
  const selectionControls = document.querySelectorAll("input[name=selectedFiles]");
  if (selectionControls.length) payload.selectedFiles = [...selectionControls].filter((item) => item.checked).map((item) => item.value);
  if ($("#individual-trim").checked) {
    payload.trackTrims = Object.fromEntries([...document.querySelectorAll(".wave-track")].map((row) => [decodeURIComponent(row.dataset.track), {
      start: row.querySelector(".track-trim-start").value,
      end: row.querySelector(".track-trim-end").value,
    }]));
  }
  const previewGains = document.querySelectorAll(".wave-track");
  if (previewGains.length) {
    payload.previewGains = Object.fromEntries([...previewGains].map((row) => [
      decodeURIComponent(row.dataset.track), row.querySelector(".track-preview-volume input[type=range]")?.value || "0",
    ]));
  }
  try {
    const result = await api("/api/convert", { method: "POST", body: JSON.stringify(payload) });
    watch(result.job);
  } catch (error) { alert(error.message); $("#convert-button").disabled = false; }
});

$("#choose-folder").addEventListener("click", async (event) => {
  if (selectingFolder) return;
  selectingFolder = true;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = t("choosingFolder");
  try {
    const result = await api("/api/select-folder", { method:"POST", body:JSON.stringify({language:currentLanguage()}) });
    if (result.path) {
      resetWaveformState();
      $("#source").value = result.path.replace(/\/$/, "");
    }
    // Cancelling the native picker is intentional and needs no alert.
  } catch (error) {
    alert(error.message);
  } finally {
    selectingFolder = false;
    button.disabled = false;
    button.textContent = t("choose");
  }
});
$("#source").addEventListener("input", resetWaveformState);
const previewLimiter = $("#preview-limiter");
const savedPreviewLimiter = localStorage.getItem(PREVIEW_LIMITER_PREFERENCE_KEY);
if (savedPreviewLimiter !== null) previewLimiter.checked = savedPreviewLimiter === "true";
previewLimiter.addEventListener("change", () => {
  localStorage.setItem(PREVIEW_LIMITER_PREFERENCE_KEY, String(previewLimiter.checked));
  document.querySelectorAll(".wave-track").forEach((row) => applyPreviewAudioSettings(row, previewLimiter));
});
$("#output-format").addEventListener("change", updateOutputFormat);
$("#load-waveforms").addEventListener("click", async () => {
  const source = $("#source").value.trim();
  if (!source) { alert(t("chooseSourceFirst")); return; }
  $("#load-waveforms").disabled = true;
  $("#waveform-status").textContent = t("loadingWaveforms");
  $("#waveform-status").classList.add("waveform-log");
  $("#waveforms").innerHTML = "";
  try { pollWaveforms((await api("/api/waveforms", { method:"POST", body:JSON.stringify({source, language:currentLanguage(), splitStereo: $("#split-stereo").checked}) })).job); }
  catch (error) { $("#load-waveforms").disabled = false; $("#waveform-status").textContent = error.message; }
});
$("#trim-start").addEventListener("input", () => syncTrim("start"));
$("#trim-end").addEventListener("input", () => syncTrim("end"));
$("#trim-start-range").addEventListener("input", (event) => { $("#trim-start").value = event.target.value; syncTrim("start"); });
$("#trim-end-range").addEventListener("input", (event) => { $("#trim-end").value = event.target.value; syncTrim("end"); });
document.querySelectorAll("input[name=trimMode]").forEach((input) => input.addEventListener("change", updateIndividualTrimMode));
document.querySelectorAll("input[name=mode]").forEach((input) => input.addEventListener("change", updateLevelOptions));
$("#auto-deselect-silent").addEventListener("click", autoDeselectSilentTracks);
$("#waveforms").addEventListener("input", (event) => {
  const row = event.target.closest(".wave-track");
  if (event.target.matches("input[name=selectedFiles]")) {
    // A manual track choice replaces the automatic audible-only selection.
    updateTrackSelectionState(row);
    return;
  }
  if (row) lastPreviewRow = row;
  if (event.target.matches(".track-trim-start-range")) row.querySelector(".track-trim-start").value = event.target.value;
  if (event.target.matches(".track-trim-end-range")) row.querySelector(".track-trim-end").value = event.target.value;
  if (event.target.matches(".track-trim-start, .track-trim-end, .track-trim-start-range, .track-trim-end-range")) syncIndividualTrim(row);
});
$("#waveforms").addEventListener("click", (event) => {
  const button = event.target.closest(".track-collapse-button");
  if (!button) return;
  const row = button.closest(".wave-track");
  const collapsed = row.classList.toggle("track-collapsed");
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = t(collapsed ? "expandTrack" : "collapseTrack");
  button.textContent = t(collapsed ? "expandTrack" : "collapseTrack");
});
$("#waveforms").addEventListener("click", (event) => {
  const button = event.target.closest(".track-preview-button");
  if (button) {
    lastPreviewRow = button.closest(".wave-track");
    toggleTrackPreview(lastPreviewRow);
  }
  const waveform = event.target.closest(".wave-image");
  if (waveform) {
    const row = waveform.closest(".wave-track");
    const audio = row?.querySelector(".track-preview-audio");
    if (!row || row.classList.contains("is-deselected") || !audio) return;
    lastPreviewRow = row;
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seekPlaybackFromPointer(row, event.clientX);
    else {
      audio.addEventListener("loadedmetadata", () => seekPlaybackFromPointer(row, event.clientX), { once: true });
      audio.load();
    }
  }
});
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName) || event.target.isContentEditable) return;
  if (!lastPreviewRow || lastPreviewRow.classList.contains("is-deselected")) return;
  event.preventDefault();
  toggleTrackPreview(lastPreviewRow);
});
function beginSharedMarkerDrag(event) {
  const marker = event.target.closest(".trim-marker");
  if (!marker || event.button !== 0) return;
  const row = marker.closest(".wave-track");
  if (row.classList.contains("is-deselected")) return;
  event.preventDefault();
  const individual = $("#individual-trim").checked;
  globalMarkerDrag = { row, marker, individual };
  if (event.pointerId !== undefined) marker.setPointerCapture?.(event.pointerId);
  if (individual) setIndividualTrimFromMarker(row, marker, event.clientX);
  else setSharedTrimFromMarker(row, marker, event.clientX);
}
$("#waveforms").addEventListener("pointerdown", beginSharedMarkerDrag);
$("#waveforms").addEventListener("mousedown", beginSharedMarkerDrag);
$("#waveforms").addEventListener("pointerdown", beginPlaybackDrag);
$("#waveforms").addEventListener("mousedown", beginPlaybackDrag);
window.addEventListener("pointermove", dragSharedMarker, { passive: false });
window.addEventListener("pointerup", endSharedMarkerDrag);
window.addEventListener("pointercancel", endSharedMarkerDrag);
window.addEventListener("mousemove", dragSharedMarker, { passive: false });
window.addEventListener("mouseup", endSharedMarkerDrag);
window.addEventListener("pointermove", dragPlayback, { passive: false });
window.addEventListener("pointerup", endPlaybackDrag);
window.addEventListener("pointercancel", endPlaybackDrag);
window.addEventListener("mousemove", dragPlayback, { passive: false });
window.addEventListener("mouseup", endPlaybackDrag);
$("#select-all").addEventListener("click", () => { document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = true; updateTrackSelectionState(item.closest(".wave-track")); }); });
$("#select-none").addEventListener("click", () => { document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = false; updateTrackSelectionState(item.closest(".wave-track")); }); });
$("#all-preview-button").addEventListener("click", () => {
  if ($("#all-preview-button").dataset.playing === "true") stopAllTrackPreviews();
  else startAllTrackPreviews();
});
$("#reset-playheads-button").addEventListener("click", resetAllPlayheads);
document.querySelectorAll("input[name=playheadMode]").forEach((input) => input.addEventListener("change", () => {
  if ($("#linked-playheads").checked && lastPreviewRow) {
    const audio = lastPreviewRow.querySelector(".track-preview-audio");
    if (audio) syncSharedPlaybackPosition(lastPreviewRow, audio.currentTime);
  }
}));
window.addEventListener("resize", () => {
  if ($("#individual-trim").checked) document.querySelectorAll(".wave-track").forEach((row) => syncIndividualTrim(row));
  else syncTrim();
});
$("#open-output").addEventListener("click", async (event) => {
  try { await api("/api/open-folder", { method:"POST", body:JSON.stringify({path:event.currentTarget.dataset.path, language:currentLanguage()}) }); }
  catch (error) { alert(error.message); }
});
const openFinderToggle = $("#open-output-toggle");
const savedOpenFinderPreference = localStorage.getItem(OPEN_FINDER_PREFERENCE_KEY);
if (savedOpenFinderPreference !== null) openFinderToggle.checked = savedOpenFinderPreference === "true";
openFinderToggle.addEventListener("change", () => localStorage.setItem(OPEN_FINDER_PREFERENCE_KEY, String(openFinderToggle.checked)));

$("#install-button").addEventListener("click", async () => {
  if (!confirm(t("installConfirm"))) return;
  try { watch((await api("/api/dependencies", { method:"POST", body:JSON.stringify({action:"install", language:currentLanguage()}) })).job); }
  catch (error) { alert(error.message); }
});
$("#uninstall-button").addEventListener("click", async () => {
  if (!confirm(t("uninstallConfirm"))) return;
  try { watch((await api("/api/dependencies", { method:"POST", body:JSON.stringify({action:"uninstall", language:currentLanguage()}) })).job); }
  catch (error) { alert(error.message); }
});

$("#language-select").addEventListener("change", async (event) => {
  try { await changeLanguage(event.target.value); }
  catch (error) { alert(error.message); event.target.value = currentLanguage(); }
});
document.addEventListener("languagechange", () => {
  updateOutputFormat();
  syncAllPreviewButton();
  document.querySelectorAll(".track-collapse-button").forEach((button) => {
    const collapsed = button.closest(".wave-track")?.classList.contains("track-collapsed");
    button.title = t(collapsed ? "expandTrack" : "collapseTrack");
    button.textContent = t(collapsed ? "expandTrack" : "collapseTrack");
  });
  refreshStatus().catch((error) => { $("#dependency-status").textContent = `${t("unable")}${error.message}`; });
});

// This is a browser-local preference: it is restored for later exports, but
// does not affect any files or settings outside this app.
const zipCheckbox = document.querySelector("input[name=packageZip]");
const savedZipPreference = localStorage.getItem(ZIP_PREFERENCE_KEY);
if (savedZipPreference !== null) zipCheckbox.checked = savedZipPreference === "true";
zipCheckbox.addEventListener("change", () => localStorage.setItem(ZIP_PREFERENCE_KEY, String(zipCheckbox.checked)));
const splitStereoCheckbox = document.querySelector("#split-stereo");
const savedSplitStereoPreference = localStorage.getItem(SPLIT_STEREO_PREFERENCE_KEY);
if (savedSplitStereoPreference !== null) splitStereoCheckbox.checked = savedSplitStereoPreference === "true";
splitStereoCheckbox.addEventListener("change", () => {
  localStorage.setItem(SPLIT_STEREO_PREFERENCE_KEY, String(splitStereoCheckbox.checked));
  resetWaveformState();
  $("#waveform-status").textContent = t("splitStereoReloadWaveform");
});
initializeLanguage().catch((error) => {
  $("#dependency-status").textContent = `Unable to load interface language: ${error.message}`;
});
updateLevelOptions();
