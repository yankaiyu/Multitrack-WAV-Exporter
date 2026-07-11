const $ = (selector) => document.querySelector(selector);
let poller;
const translations = {
  en: { pageTitle:"Multitrack WAV Exporter", appName:"Multitrack WAV Exporter", language:"Language", lede:"Batch-export 32-bit float WAV files as safe, shareable MP3s.", dependencies:"Dependencies", checking:"Checking FFmpeg…", install:"↓ Install / Repair", uninstall:"Uninstall app-managed dependencies", exportSettings:"Export settings", sourceFolder:"Source folder", choose:"Choose…", sourceHelp:"Reads WAVs in this folder; outputs to <code>normalized_mp3</code>.", levelProcessing:"Level processing", perTrack:"Normalize each track", perTrackHelp:"Best for pre-fader recordings. Adjust each track independently, then remix after import.", preserve:"Preserve relative levels", preserveHelp:"Apply one gain to the whole group, retaining the original balance.", convert:"Keep levels where safe", convertHelp:"Only lower and re-encode a track if its encoded MP3 exceeds the safety ceiling.", bitrate:"MP3 bitrate", recommendedBitrate:"256 kbps (recommended)", sampleRate:"Sample rate", keepOriginal:"Keep original (recommended)", safePeak:"Final MP3 safety ceiling", recommendedCeiling:"-2.0 dBFS (recommended)", silenceThreshold:"Empty-track threshold", onlyDigital:"-90 dBFS (only digital silence)", recommendedThreshold:"-40 dBFS (recommended)", notice:"Cleans NaN/Infinity, measures true peaks, then verifies the MP3. Float audio above 0 dBFS is safely reduced.", zip:"Also create a ZIP share package", start:"▶ Start export", processing:"Processing…", running:"Running", done:"Done", error:"Error", openFinder:"▣ Open in Finder", ready:"Ready: FFmpeg is available.", missingFfmpeg:"FFmpeg is not ready.", unable:"Unable to check dependencies: ", installConfirm:"This will use Homebrew to install missing local dependencies. Continue?", uninstallConfirm:"Only dependencies installed and recorded by this app will be removed. Continue?", output:"Output folder: ", zipOutput:"Share ZIP: ", selectionCancelled:"No folder was selected." },
  zh: { pageTitle:"多轨 WAV 批量导出", appName:"多轨 WAV 批量导出", language:"语言", lede:"将多个 32-bit float WAV 安全批量导出为便于分享的 MP3。", dependencies:"运行依赖", checking:"正在检查 FFmpeg…", install:"↓ 安装 / 修复依赖", uninstall:"卸载本工具安装的依赖", exportSettings:"导出设置", sourceFolder:"歌曲文件夹", choose:"选择…", sourceHelp:"读取此文件夹中的 WAV；输出至 <code>normalized_mp3</code>。", levelProcessing:"音量处理", perTrack:"每轨标准化", perTrackHelp:"适合 pre-fader 原始录音。每条轨道独立调整，导入后重新混音。", preserve:"保持相对响度", preserveHelp:"整组轨道使用同一增益，保留原有轨间平衡。", convert:"尽量保持原音量，仅安全降幅", convertHelp:"仅当编码后超过安全上限时，才降低该轨并重编码。", bitrate:"MP3 比特率", recommendedBitrate:"256 kbps（推荐）", sampleRate:"采样率", keepOriginal:"保持原始（推荐）", safePeak:"最终 MP3 安全峰值", recommendedCeiling:"-2.0 dBFS（推荐）", silenceThreshold:"无输入/底噪阈值", onlyDigital:"-90 dBFS（仅数字静音）", recommendedThreshold:"-40 dBFS（推荐）", notice:"清洗 NaN / Infinity、测量实际峰值，并复检生成的 MP3。高于 0 dBFS 的浮点信号会安全降低。", zip:"同时创建 ZIP 分享包", start:"▶ 开始转换", processing:"正在处理…", running:"运行中", done:"完成", error:"出错", openFinder:"▣ 在 Finder 中打开", ready:"已就绪：FFmpeg 可用。", missingFfmpeg:"FFmpeg 未就绪。", unable:"无法检查依赖：", installConfirm:"将通过 Homebrew 安装缺少的本地依赖。继续？", uninstallConfirm:"只会卸载本工具曾安装并记录的依赖。继续？", output:"输出文件夹：", zipOutput:"分享 ZIP：", selectionCancelled:"未选择文件夹。" }
};
Object.assign(translations.en, { trimTitle:"Waveforms & trim", trimHelp:"Optional. Load waveforms to trim or choose tracks.", loadWaveforms:"〰️ Load waveforms", trimStart:"Start (seconds)", trimEnd:"End (seconds)", individualTrim:"Individual trim", autoDeselectSilent:"🔊 Select audible tracks only", autoDeselectSilentHelp:"Uses the threshold below. Off by default.", trackStart:"Start", trackEnd:"End", loadingWaveforms:"Generating waveforms…", waveformsReady:"Ready. Drag sliders or enter times.", chooseSourceFirst:"Choose a source folder first.", selectAll:"✓ Select all", selectNone:"✕ Select none" });
Object.assign(translations.zh, { trimTitle:"波形与裁剪", trimHelp:"可选：加载波形后可裁剪或选择轨道。", loadWaveforms:"〰️ 加载波形", trimStart:"开始时间（秒）", trimEnd:"结束时间（秒）", individualTrim:"逐轨裁剪", autoDeselectSilent:"🔊 只选择有声轨道", autoDeselectSilentHelp:"按下方阈值判断；默认关闭。", trackStart:"开始", trackEnd:"结束", loadingWaveforms:"正在生成波形…", waveformsReady:"已就绪。拖动滑块或输入时间。", chooseSourceFirst:"请先选择歌曲文件夹。", selectAll:"✓ 全选", selectNone:"✕ 全不选" });
Object.assign(translations.en, { speedMode:"Processing speed", speedConservative:"Conservative — 1 track at a time", speedBalanced:"Balanced — 2 tracks at a time (recommended)", speedFast:"Fast — 4 tracks at a time", speedHelp:"More tracks can finish one song sooner, but use more CPU and disk. This does not combine separate web jobs." });
Object.assign(translations.zh, { speedMode:"处理速度", speedConservative:"保守 — 一次处理 1 条轨道", speedBalanced:"平衡 — 一次处理 2 条轨道（推荐）", speedFast:"快速 — 一次处理 4 条轨道", speedHelp:"更高并发可让同一首歌更快完成，但会占用更多 CPU 和磁盘；不会合并不同网页任务。" });
let language = localStorage.getItem("language") || (navigator.language.startsWith("zh") ? "zh" : "en");
const t = (key) => translations[language][key] || key;
const ZIP_PREFERENCE_KEY = "packageZip";

function applyLanguage() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.title = t("pageTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((node) => { node.innerHTML = t(node.dataset.i18nHtml); });
  $("#language-select").value = language;
  refreshStatus();
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function sendHeartbeat() {
  api("/api/heartbeat", { method:"POST", body:"{}" }).catch(() => {});
}

async function refreshStatus() {
  const status = await api("/api/status");
  const ready = status.ffmpeg;
  $("#dependency-status").textContent = ready ? t("ready") : t("missingFfmpeg");
  $("#convert-button").disabled = !ready;
}

let waveformTracks = [];
let waveformDuration = 0;

function resetWaveformState() {
  waveformTracks = [];
  waveformDuration = 0;
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
    const duration = Number(overlay.dataset.duration) || waveformDuration;
    overlay.style.left = `${Math.min(100, start / duration * 100)}%`;
    overlay.style.right = `${Math.max(0, 100 - end / duration * 100)}%`;
  });
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
}

function renderWaveforms(preview) {
  waveformTracks = preview;
  waveformDuration = Math.min(...preview.map((track) => track.duration));
  const waves = $("#waveforms");
  waves.innerHTML = preview.map((track) => {
    const trackId = encodeURIComponent(track.name);
    return `<div class="wave-track" data-track="${trackId}" data-duration="${track.duration}"><label class="wave-name track-select"><input type="checkbox" name="selectedFiles" value="${track.name}" checked />${track.name}</label><div class="track-trim-controls hidden"><label>${t("trackStart")}<input class="track-trim-start" type="number" min="0" max="${track.duration}" step="0.001" value="0" /></label><label>${t("trackEnd")}<input class="track-trim-end" type="number" min="0" max="${track.duration}" step="0.001" value="${track.duration.toFixed(3)}" /></label><div class="track-range-controls"><div class="track-range-rail"></div><div class="track-range-fill"></div><input class="track-trim-start-range" type="range" min="0" max="${track.duration}" step="0.001" value="0" /><input class="track-trim-end-range" type="range" min="0" max="${track.duration}" step="0.001" value="${track.duration}" /></div></div><img class="wave-image" src="${track.image}" alt="${track.name}" /><div class="trim-range-overlay" data-duration="${track.duration}"></div></div>`;
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

function watch(job) {
  clearInterval(poller);
  $("#job-panel").classList.remove("hidden");
  $("#job-title").textContent = t("processing");
  $("#job-state").textContent = t("running");
  $("#job-progress-bar").style.width = "0%";
  $("#job-progress-text").textContent = "0%";
  $("#job-log").textContent = "";
  $("#output-path").textContent = "";
  $("#open-output").classList.add("hidden");
  poller = setInterval(async () => {
    const data = await api(`/api/job/${job}`);
    $("#job-log").textContent = data.log || "";
    $("#job-log").scrollTop = $("#job-log").scrollHeight;
    // Static files can refresh while an older local Python server is still running.
    // Treat a completed legacy job as 100% instead of misleadingly showing 0%.
    const progress = data.status === "done" ? 100 : Number(data.progress || 0);
    $("#job-progress-bar").style.width = `${progress}%`;
    $("#job-progress-text").textContent = data.progressLabel ? `${progress}% · ${data.progressLabel}` : `${progress}%`;
    if (data.status !== "running") {
      clearInterval(poller);
      const success = data.status === "done";
      $("#job-title").textContent = success ? t("done") : t("error");
      $("#job-state").textContent = success ? t("done") : t("error");
      $("#output-path").textContent = data.output ? `${t("output")}${data.output}${data.zip ? `\n${t("zipOutput")}${data.zip}` : ""}` : "";
      if (data.output && success) { $("#open-output").classList.remove("hidden"); $("#open-output").dataset.path = data.output; }
      $("#convert-button").disabled = false;
      refreshStatus();
    }
  }, 700);
}

$("#convert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#convert-button").disabled = true;
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form);
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

$("#choose-folder").addEventListener("click", async () => {
  try { const result = await api("/api/select-folder", { method:"POST", body:JSON.stringify({language}) }); if (result.path) { resetWaveformState(); $("#source").value = result.path.replace(/\/$/, ""); } else alert(`${t("selectionCancelled")}${result.error ? `\n${result.error}` : ""}`); }
  catch (error) { alert(error.message); }
});
$("#source").addEventListener("input", resetWaveformState);
$("#load-waveforms").addEventListener("click", async () => {
  const source = $("#source").value.trim();
  if (!source) { alert(t("chooseSourceFirst")); return; }
  $("#load-waveforms").disabled = true;
  $("#waveform-status").textContent = t("loadingWaveforms");
  $("#waveforms").innerHTML = "";
  try { pollWaveforms((await api("/api/waveforms", { method:"POST", body:JSON.stringify({source}) })).job); }
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
$("#select-all").addEventListener("click", () => { $("#auto-deselect-silent").checked = false; document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = true; updateTrackSelectionState(item.closest(".wave-track")); }); });
$("#select-none").addEventListener("click", () => { $("#auto-deselect-silent").checked = false; document.querySelectorAll("input[name=selectedFiles]").forEach((item) => { item.checked = false; updateTrackSelectionState(item.closest(".wave-track")); }); });
window.addEventListener("resize", () => {
  if (!$("#individual-trim").checked) return;
  document.querySelectorAll(".wave-track").forEach((row) => syncIndividualTrim(row));
});
$("#open-output").addEventListener("click", async (event) => {
  try { await api("/api/open-folder", { method:"POST", body:JSON.stringify({path:event.currentTarget.dataset.path}) }); }
  catch (error) { alert(error.message); }
});

$("#install-button").addEventListener("click", async () => {
  if (!confirm(t("installConfirm"))) return;
  try { watch((await api("/api/dependencies", { method:"POST", body:JSON.stringify({action:"install"}) })).job); }
  catch (error) { alert(error.message); }
});
$("#uninstall-button").addEventListener("click", async () => {
  if (!confirm(t("uninstallConfirm"))) return;
  try { watch((await api("/api/dependencies", { method:"POST", body:JSON.stringify({action:"uninstall"}) })).job); }
  catch (error) { alert(error.message); }
});

$("#language-select").addEventListener("change", (event) => { language = event.target.value; localStorage.setItem("language", language); applyLanguage(); });

// This is a browser-local preference: it is restored for later exports, but
// does not affect any files or settings outside this app.
const zipCheckbox = document.querySelector("input[name=packageZip]");
const savedZipPreference = localStorage.getItem(ZIP_PREFERENCE_KEY);
if (savedZipPreference !== null) zipCheckbox.checked = savedZipPreference === "true";
zipCheckbox.addEventListener("change", () => localStorage.setItem(ZIP_PREFERENCE_KEY, String(zipCheckbox.checked)));
applyLanguage();
sendHeartbeat();
const heartbeatTimer = setInterval(sendHeartbeat, 5000);
window.addEventListener("pagehide", () => clearInterval(heartbeatTimer));
refreshStatus().catch((error) => { $("#dependency-status").textContent = `${t("unable")}${error.message}`; });
