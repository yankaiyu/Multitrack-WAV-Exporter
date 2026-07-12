import { $, api } from "./core.js";
import { changeLanguage, currentLanguage, initializeLanguage, t } from "./i18n.js";
import { refreshStatus, watch } from "./jobs.js";

const ZIP_PREFERENCE_KEY = "packageZip";
const SPLIT_STEREO_PREFERENCE_KEY = "splitStereo";
let selectingFolder = false;

function sendHeartbeat() {
  api("/api/heartbeat", { method:"POST", body:"{}" }).catch(() => {});
}

let waveformTracks = [];
let waveformDuration = 0;
let globalMarkerDrag = null;
let playbackDrag = null;

function resetWaveformState() {
  document.querySelectorAll(".track-preview-audio").forEach((audio) => audio.pause());
  waveformTracks = [];
  waveformDuration = 0;
  globalMarkerDrag = null;
  playbackDrag = null;
  $("#waveforms").innerHTML = "";
  $("#waveform-status").textContent = "";
  $("#trim-controls").classList.add("hidden");
  $("#individual-trim-option").classList.add("hidden");
  $("#individual-trim").checked = false;
  $("#auto-deselect-silent-option").classList.add("hidden");
  $("#auto-deselect-silent").checked = false;
  $("#select-all").classList.add("hidden");
  $("#select-none").classList.add("hidden");
  $("#trim-start").value = "0";
  $("#trim-end").value = "";
}

function updateOutputFormat() {
  const format = $("#output-format").value;
  $("#bitrate-field").classList.toggle("hidden", format === "wav");
  $("#wav-depth-field").classList.toggle("hidden", format !== "wav");
  $("#bitrate-label").textContent = t(format === "m4a" ? "aacBitrate" : "bitrate");
}

function syncTrim(changed = "") {
  if (!waveformDuration) return;
  let start = Number($("#trim-start").value) || 0;
  let end = Number($("#trim-end").value) || waveformDuration;
  start = Math.max(0, Math.min(start, waveformDuration));
  end = Math.max(0, Math.min(end, waveformDuration));
  if (changed === "start" && start >= end) end = Math.min(waveformDuration, start + 0.001);
  if (changed === "end" && end <= start) start = Math.max(0, end - 0.001);
  $("#trim-start").value = start.toFixed(3);
  $("#trim-end").value = end.toFixed(3);
  $("#trim-start-range").value = start;
  $("#trim-end-range").value = end;
  $("#trim-fill").style.left = `${start / waveformDuration * 100}%`;
  $("#trim-fill").style.width = `${(end - start) / waveformDuration * 100}%`;
  document.querySelectorAll(".wave-track:not(.individual-trim-active) .trim-range-overlay").forEach((overlay) => {
    // Individual trim positions this overlay with inline pixels. Clear that
    // value when returning to shared trim so the shared marker is visible.
    overlay.style.top = "";
    const duration = Number(overlay.dataset.duration) || waveformDuration;
    overlay.style.left = `${Math.min(100, start / duration * 100)}%`;
    overlay.style.right = `${Math.max(0, 100 - end / duration * 100)}%`;
  });
  reconcileTrackPreviews();
}

function setSharedTrimFromMarker(row, marker, clientX) {
  const waveform = row.querySelector(".wave-image");
  const bounds = waveform.getBoundingClientRect();
  const duration = Number(row.dataset.duration) || waveformDuration;
  if (!bounds.width || !duration) return;
  const time = Math.max(0, Math.min(waveformDuration, (clientX - bounds.left) / bounds.width * duration));
  const isStart = marker.dataset.marker === "start";
  $(isStart ? "#trim-start" : "#trim-end").value = time;
  syncTrim(isStart ? "start" : "end");
}

function setIndividualTrimFromMarker(row, marker, clientX) {
  const waveform = row.querySelector(".wave-image");
  const bounds = waveform.getBoundingClientRect();
  const duration = Number(row.dataset.duration);
  if (!bounds.width || !duration) return;
  const time = Math.max(0, Math.min(duration, (clientX - bounds.left) / bounds.width * duration));
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
}

function beginPlaybackDrag(event) {
  const marker = event.target.closest(".playback-marker");
  if (!marker || event.button !== 0) return;
  const row = marker.closest(".wave-track");
  const audio = row?.querySelector(".track-preview-audio");
  if (!row || row.classList.contains("is-deselected") || !audio || audio.readyState < HTMLMediaElement.HAVE_METADATA) return;
  event.preventDefault();
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
  let start = Number(row.querySelector(".track-trim-start").value) || 0;
  let end = Number(row.querySelector(".track-trim-end").value) || duration;
  start = Math.max(0, Math.min(start, duration));
  end = Math.max(0, Math.min(end, duration));
  if (start >= end) end = Math.min(duration, start + 0.001);
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
  overlay.style.top = `${waveform.offsetTop}px`;
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
  if (!selected) stopTrackPreview(row, true);
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
  const marker = row.querySelector(".playback-marker");
  if (!button) return;
  button.classList.toggle("is-playing", playing);
  button.textContent = playing ? t("previewPause") : t("previewPlay");
  marker?.classList.toggle("hidden", !playing);
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
    if (!audio || audio.paused) return;
    const { start, end } = previewBounds(row);
    // A newly moved trim boundary must never leave an old audio position playing
    // beyond the highlighted range. Stop at the new start so the next Play is exact.
    if (audio.currentTime < start || audio.currentTime >= end) stopTrackPreview(row, true);
    else updatePlaybackMarker(row);
  });
}

function stopTrackPreview(row, reset = false) {
  const audio = row.querySelector(".track-preview-audio");
  if (!audio) return;
  audio.pause();
  if (reset && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    audio.currentTime = previewBounds(row).start;
    audio.dataset.previewPosition = String(audio.currentTime);
  }
  setPreviewButton(row, false);
}

function startTrackPreview(row) {
  const audio = row.querySelector(".track-preview-audio");
  if (!audio) return;
  document.querySelectorAll(".wave-track").forEach((other) => { if (other !== row) stopTrackPreview(other); });
  const bounds = previewBounds(row);
  const savedPosition = Number(audio.dataset.previewPosition);
  const start = Number.isFinite(savedPosition) && savedPosition >= bounds.start && savedPosition < bounds.end
    ? savedPosition : bounds.start;
  const play = () => {
    audio.currentTime = start;
    audio.play().then(() => {
      setPreviewButton(row, true);
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

function renderWaveforms(preview) {
  waveformTracks = preview;
  waveformDuration = Math.min(...preview.map((track) => track.duration));
  const waves = $("#waveforms");
  waves.innerHTML = preview.map((track) => {
    const trackId = encodeURIComponent(track.name);
    return `<div class="wave-track" data-track="${trackId}" data-duration="${track.duration}"><label class="wave-name track-select"><input type="checkbox" name="selectedFiles" value="${track.name}" checked />${track.name}</label><button class="track-preview-button secondary" type="button">${t("previewPlay")}</button><audio class="track-preview-audio" preload="metadata" src="${track.audio}"></audio><div class="track-trim-controls hidden"><label>${t("trackStart")}<input class="track-trim-start" type="number" min="0" max="${track.duration}" step="0.001" value="0" /></label><label>${t("trackEnd")}<input class="track-trim-end" type="number" min="0" max="${track.duration}" step="0.001" value="${track.duration.toFixed(3)}" /></label><div class="track-range-controls"><div class="track-range-rail"></div><div class="track-range-fill"></div><input class="track-trim-start-range" type="range" min="0" max="${track.duration}" step="0.001" value="0" /><input class="track-trim-end-range" type="range" min="0" max="${track.duration}" step="0.001" value="${track.duration}" /></div></div><img class="wave-image" src="${track.image}" alt="${track.name}" /><div class="trim-range-overlay" data-duration="${track.duration}"><span class="playback-marker hidden" aria-hidden="true"></span><span class="trim-marker trim-marker-start" data-marker="start" aria-label="Trim start"></span><span class="trim-marker trim-marker-end" data-marker="end" aria-label="Trim end"></span></div></div>`;
  }).join("");
  ["#trim-start-range", "#trim-end-range"].forEach((selector) => { $(selector).max = waveformDuration; });
  $("#trim-end").max = waveformDuration;
  $("#trim-controls").classList.remove("hidden");
  $("#select-all").classList.remove("hidden");
  $("#select-none").classList.remove("hidden");
  $("#trim-end").value = waveformDuration.toFixed(3);
  const uneven = Math.max(...preview.map((track) => track.duration)) - waveformDuration > 0.01;
  $("#individual-trim-option").classList.remove("hidden");
  $("#auto-deselect-silent-option").classList.remove("hidden");
  $("#individual-trim").checked = uneven;
  updateIndividualTrimMode();
  $("#waveform-status").textContent = t("waveformsReady");
  syncTrim();
  document.querySelectorAll(".track-preview-audio").forEach((audio) => {
    const row = audio.closest(".wave-track");
    audio.addEventListener("timeupdate", () => {
      audio.dataset.previewPosition = String(audio.currentTime);
      if (audio.currentTime >= previewBounds(row).end) stopTrackPreview(row, true);
      else updatePlaybackMarker(row);
    });
    audio.addEventListener("ended", () => setPreviewButton(row, false));
    audio.addEventListener("error", () => setPreviewButton(row, false));
  });
}

function autoDeselectSilentTracks() {
  if (!$("#auto-deselect-silent").checked) return;
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
  const selectionControls = document.querySelectorAll("input[name=selectedFiles]");
  if (selectionControls.length) payload.selectedFiles = [...selectionControls].filter((item) => item.checked).map((item) => item.value);
  if ($("#individual-trim").checked) {
    payload.trackTrims = Object.fromEntries([...document.querySelectorAll(".wave-track")].map((row) => [decodeURIComponent(row.dataset.track), {
      start: row.querySelector(".track-trim-start").value,
      end: row.querySelector(".track-trim-end").value,
    }]));
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
$("#output-format").addEventListener("change", updateOutputFormat);
$("#load-waveforms").addEventListener("click", async () => {
  const source = $("#source").value.trim();
  if (!source) { alert(t("chooseSourceFirst")); return; }
  $("#load-waveforms").disabled = true;
  $("#waveform-status").textContent = t("loadingWaveforms");
  $("#waveforms").innerHTML = "";
  try { pollWaveforms((await api("/api/waveforms", { method:"POST", body:JSON.stringify({source, language:currentLanguage(), splitStereo: $("#split-stereo").checked}) })).job); }
  catch (error) { $("#load-waveforms").disabled = false; $("#waveform-status").textContent = error.message; }
});
$("#trim-start").addEventListener("input", () => syncTrim("start"));
$("#trim-end").addEventListener("input", () => syncTrim("end"));
$("#trim-start-range").addEventListener("input", (event) => { $("#trim-start").value = event.target.value; syncTrim("start"); });
$("#trim-end-range").addEventListener("input", (event) => { $("#trim-end").value = event.target.value; syncTrim("end"); });
$("#individual-trim").addEventListener("change", updateIndividualTrimMode);
$("#auto-deselect-silent").addEventListener("change", autoDeselectSilentTracks);
document.querySelector("select[name=silenceThreshold]").addEventListener("change", autoDeselectSilentTracks);
$("#waveforms").addEventListener("input", (event) => {
  const row = event.target.closest(".wave-track");
  if (event.target.matches("input[name=selectedFiles]")) {
    // A manual track choice replaces the automatic audible-only selection.
    $("#auto-deselect-silent").checked = false;
    updateTrackSelectionState(row);
    return;
  }
  if (event.target.matches(".track-trim-start-range")) row.querySelector(".track-trim-start").value = event.target.value;
  if (event.target.matches(".track-trim-end-range")) row.querySelector(".track-trim-end").value = event.target.value;
  if (event.target.matches(".track-trim-start, .track-trim-end, .track-trim-start-range, .track-trim-end-range")) syncIndividualTrim(row);
});
$("#waveforms").addEventListener("click", (event) => {
  const button = event.target.closest(".track-preview-button");
  if (button) toggleTrackPreview(button.closest(".wave-track"));
  const waveform = event.target.closest(".wave-image");
  if (waveform) {
    const row = waveform.closest(".wave-track");
    const audio = row?.querySelector(".track-preview-audio");
    if (!row || row.classList.contains("is-deselected") || !audio) return;
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) seekPlaybackFromPointer(row, event.clientX);
    else {
      audio.addEventListener("loadedmetadata", () => seekPlaybackFromPointer(row, event.clientX), { once: true });
      audio.load();
    }
  }
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
$("#select-all").addEventListener("click", () => { $("#auto-deselect-silent").checked = false; document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = true; updateTrackSelectionState(item.closest(".wave-track")); }); });
$("#select-none").addEventListener("click", () => { $("#auto-deselect-silent").checked = false; document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = false; updateTrackSelectionState(item.closest(".wave-track")); }); });
window.addEventListener("resize", () => {
  if (!$("#individual-trim").checked) return;
  document.querySelectorAll(".wave-track").forEach((row) => syncIndividualTrim(row));
});
$("#open-output").addEventListener("click", async (event) => {
  try { await api("/api/open-folder", { method:"POST", body:JSON.stringify({path:event.currentTarget.dataset.path, language:currentLanguage()}) }); }
  catch (error) { alert(error.message); }
});

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
initializeLanguage().then(() => {
  sendHeartbeat();
  const heartbeatTimer = setInterval(sendHeartbeat, 5000);
  window.addEventListener("pagehide", () => clearInterval(heartbeatTimer));
}).catch((error) => {
  $("#dependency-status").textContent = `Unable to load interface language: ${error.message}`;
});
