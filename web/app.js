const $ = (selector) => document.querySelector(selector);
let poller;
const translations = {
  en: { pageTitle:"Multitrack WAV Exporter", appName:"Multitrack WAV Exporter", language:"Language", lede:"Batch-export aligned 32-bit float WAV files as safe, shareable MP3s.", dependencies:"Dependencies", checking:"Checking FFmpeg and ffmpeg-normalize…", install:"Install / Repair", uninstall:"Uninstall app-managed dependencies", exportSettings:"Export settings", sourceFolder:"Source folder", choose:"Choose…", sourceHelp:"Reads WAVs directly inside this folder; exports to <code>normalized_mp3</code>.", levelProcessing:"Level processing", perTrack:"Normalize each track", perTrackHelp:"Best for pre-fader recordings. Adjust each track independently, then remix after import.", preserve:"Preserve relative levels", preserveHelp:"Apply one gain to the whole group, retaining the original balance.", convert:"Keep levels where safe", convertHelp:"Only lower and re-encode a track if its encoded MP3 exceeds the safety ceiling.", bitrate:"MP3 bitrate", recommendedBitrate:"256 kbps (recommended)", sampleRate:"Sample rate", keepOriginal:"Keep original (recommended)", safePeak:"Final MP3 safety ceiling", recommendedCeiling:"-2.0 dBFS (recommended)", notice:"Every mode checks decoded MP3 peaks. When a peak exceeds the ceiling, it re-encodes from the original WAV at a lower level to avoid clipping.", zip:"Also create a ZIP share package (AirDrop, cloud drive, or bandmates)", start:"Start export", processing:"Processing…", running:"Running", done:"Done", error:"Error", openFinder:"Open in Finder", ready:"Ready: FFmpeg and ffmpeg-normalize are available.", missingFfmpeg:"FFmpeg and ffmpeg-normalize are not ready.", missingNormalize:"FFmpeg is ready; ffmpeg-normalize is missing.", unable:"Unable to check dependencies: ", installConfirm:"This will use Homebrew / pipx to install missing local dependencies. Continue?", uninstallConfirm:"Only dependencies installed and recorded by this app will be removed. Continue?", output:"Output folder: ", zipOutput:"Share ZIP: " },
  zh: { pageTitle:"多轨 WAV 批量导出", appName:"多轨 WAV 批量导出", language:"语言", lede:"把多个对齐的 32-bit float WAV 安全批量导出为便于分享的 MP3。", dependencies:"运行依赖", checking:"正在检查 FFmpeg 与 ffmpeg-normalize…", install:"安装 / 修复依赖", uninstall:"卸载本工具安装的依赖", exportSettings:"导出设置", sourceFolder:"歌曲文件夹", choose:"选择…", sourceHelp:"读取此文件夹第一层中的 WAV；输出至 <code>normalized_mp3</code>。", levelProcessing:"音量处理", perTrack:"每轨标准化", perTrackHelp:"适合 pre-fader 原始录音。每条轨道独立调整，导入后重新混音。", preserve:"保持相对响度", preserveHelp:"整组轨道使用同一增益，保留原有轨间平衡。", convert:"尽量保持原音量，仅安全降幅", convertHelp:"仅当编码后超过安全上限时，才降低该轨并重编码。", bitrate:"MP3 比特率", recommendedBitrate:"256 kbps（推荐）", sampleRate:"采样率", keepOriginal:"保持原始（推荐）", safePeak:"最终 MP3 安全峰值", recommendedCeiling:"-2.0 dBFS（推荐）", notice:"所有模式都会在 MP3 编码后解码检查峰值。若超过上限，工具会从原始 WAV 自动降低目标并重试，避免输出文件削波。", zip:"同时创建 ZIP 分享包（方便 AirDrop、网盘或发送给队友）", start:"开始转换", processing:"正在处理…", running:"运行中", done:"完成", error:"出错", openFinder:"在 Finder 中打开", ready:"已就绪：FFmpeg 和 ffmpeg-normalize 均可用。", missingFfmpeg:"FFmpeg 与 ffmpeg-normalize 未就绪。", missingNormalize:"FFmpeg 已就绪，缺 ffmpeg-normalize。", unable:"无法检查依赖：", installConfirm:"将通过 Homebrew / pipx 安装缺少的本地依赖。继续？", uninstallConfirm:"只会卸载本工具曾安装并记录的依赖。继续？", output:"输出文件夹：", zipOutput:"分享 ZIP：" }
};
let language = localStorage.getItem("language") || (navigator.language.startsWith("zh") ? "zh" : "en");
const t = (key) => translations[language][key] || key;

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

async function refreshStatus() {
  const status = await api("/api/status");
  const ready = status.ffmpeg && status.normalize;
  $("#dependency-status").textContent = ready ? t("ready") : (status.ffmpeg ? t("missingNormalize") : t("missingFfmpeg"));
  $("#convert-button").disabled = !ready;
}

function watch(job) {
  clearInterval(poller);
  $("#job-panel").classList.remove("hidden");
  $("#job-title").textContent = t("processing");
  $("#job-state").textContent = t("running");
  $("#job-log").textContent = "";
  $("#output-path").textContent = "";
  $("#open-output").classList.add("hidden");
  poller = setInterval(async () => {
    const data = await api(`/api/job/${job}`);
    $("#job-log").textContent = data.log || "";
    $("#job-log").scrollTop = $("#job-log").scrollHeight;
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
  try {
    const result = await api("/api/convert", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    watch(result.job);
  } catch (error) { alert(error.message); $("#convert-button").disabled = false; }
});

$("#choose-folder").addEventListener("click", async () => {
  try { const result = await api("/api/select-folder", { method:"POST", body:JSON.stringify({language}) }); if (result.path) $("#source").value = result.path.replace(/\/$/, ""); }
  catch (error) { alert(error.message); }
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
applyLanguage();
refreshStatus().catch((error) => { $("#dependency-status").textContent = `${t("unable")}${error.message}`; });
