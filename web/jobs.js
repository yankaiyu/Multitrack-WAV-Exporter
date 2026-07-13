import { $, api } from "./core.js";
import { currentLanguage, t } from "./i18n.js";

let poller;
let activeJob;

export async function refreshStatus() {
  const status = await api("/api/status");
  const ready = status.ffmpeg;
  $("#dependency-status").textContent = ready ? t("ready") : t("missingFfmpeg");
  $("#convert-button").disabled = !ready;
}

export function watch(job) {
  clearInterval(poller);
  $("#job-panel").classList.remove("hidden");
  $("#job-title").textContent = t("processing");
  $("#job-state").textContent = t("running");
  $("#job-progress-bar").style.width = "0%";
  $("#job-progress-text").textContent = "0%";
  $("#job-log").textContent = "";
  $("#output-path").textContent = "";
  $("#open-output").classList.add("hidden");
  $("#cancel-job").classList.remove("hidden");
  $("#cancel-job").disabled = false;
  $("#cancel-job").textContent = t("cancel");
  activeJob = job;
  poller = setInterval(async () => {
    const data = await api(`/api/job/${job}`);
    $("#job-log").textContent = data.log || "";
    $("#job-log").scrollTop = $("#job-log").scrollHeight;
    const progress = data.status === "done" ? 100 : Number(data.progress || 0);
    $("#job-progress-bar").style.width = `${progress}%`;
    $("#job-progress-text").textContent = data.progressLabel ? `${progress}% · ${data.progressLabel}` : `${progress}%`;
    if (data.status !== "running") {
      clearInterval(poller);
      const success = data.status === "done";
      $("#job-title").textContent = data.status === "cancelled" ? t("cancelled") : (success ? t("done") : t("error"));
      $("#job-state").textContent = data.status === "cancelled" ? t("cancelled") : (success ? t("done") : t("error"));
      $("#output-path").textContent = data.output ? `${t("output")}${data.output}${data.zip ? `\n${t("zipOutput")}${data.zip}` : ""}` : "";
      if (data.output && success) {
        $("#open-output").classList.remove("hidden");
        $("#open-output").dataset.path = data.output;
        if ($("#open-output-toggle").checked) {
          api("/api/open-folder", { method: "POST", body: JSON.stringify({path: data.output, language: currentLanguage()}) }).catch(() => {});
        }
      }
      $("#cancel-job").classList.add("hidden");
      $("#convert-button").disabled = false;
      refreshStatus();
    }
  }, 700);
}

$("#cancel-job").addEventListener("click", async () => {
  if (!activeJob) return;
  $("#cancel-job").disabled = true;
  $("#cancel-job").textContent = t("cancelling");
  try {
    await api("/api/cancel", { method: "POST", body: JSON.stringify({job: activeJob, language: currentLanguage()}) });
  } catch (error) {
    $("#cancel-job").disabled = false;
    $("#cancel-job").textContent = t("cancel");
  }
});
