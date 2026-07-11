import { $, api } from "./core.js";

let strings = {};
let language = "en";
let availableLanguages = [];

export const t = (key) => strings[key] || key;
export const currentLanguage = () => language;

async function loadLocale(code) {
  const response = await fetch(`locales/${encodeURIComponent(code)}.json`);
  if (!response.ok) throw new Error(`Could not load locale: ${code}`);
  const data = await response.json();
  if (!data.base) return data;
  const base = await loadLocale(data.base);
  return { ...base, ...data.overrides, languageName: data.languageName };
}

function applyLanguage() {
  document.documentElement.lang = language === "zh" ? "zh-CN" : language === "zh-Hant" ? "zh-TW" : language;
  document.title = t("pageTitle");
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((node) => { node.innerHTML = t(node.dataset.i18nHtml); });
  $("#language-select").value = language;
  document.querySelectorAll(".track-preview-button").forEach((button) => {
    button.textContent = button.classList.contains("is-playing") ? t("previewPause") : t("previewPlay");
  });
  document.dispatchEvent(new Event("languagechange"));
}

export async function changeLanguage(code) {
  strings = await loadLocale(code);
  language = code;
  localStorage.setItem("language", language);
  applyLanguage();
}

export async function initializeLanguage() {
  const data = await api("/api/locales");
  availableLanguages = data.locales;
  const systemTag = navigator.language.toLowerCase();
  const systemLanguage = systemTag.startsWith("zh-tw") || systemTag.startsWith("zh-hk") || systemTag.startsWith("zh-mo")
    ? "zh-Hant" : systemTag.split("-")[0];
  const preferred = localStorage.getItem("language") || systemLanguage;
  language = availableLanguages.some((item) => item.code === preferred) ? preferred : "en";
  if (!availableLanguages.some((item) => item.code === language)) language = availableLanguages[0]?.code || "en";
  $("#language-select").innerHTML = availableLanguages.map((item) => `<option value="${item.code}">${item.name}</option>`).join("");
  strings = await loadLocale(language);
  applyLanguage();
}
