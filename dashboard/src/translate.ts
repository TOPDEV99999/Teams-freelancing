/**
 * View-only translation. Order:
 *  1. Chrome's built-in on-device Translator API (Chrome 138+; private, free, works offline once the
 *     language pack is downloaded),
 *  2. the hub's /api/translate (Google Translate web endpoint) when the browser can't.
 * Nothing translated here is ever sent to Workana.
 */
import { api } from "./api";

export type Provider = "auto" | "browser" | "google";

export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" }, { code: "ko", name: "한국어 (Korean)" }, { code: "ja", name: "日本語 (Japanese)" },
  { code: "zh-CN", name: "中文 简体 (Chinese)" }, { code: "es", name: "Español" }, { code: "pt", name: "Português" },
  { code: "fr", name: "Français" }, { code: "de", name: "Deutsch" }, { code: "it", name: "Italiano" },
  { code: "ru", name: "Русский" }, { code: "uk", name: "Українська" }, { code: "vi", name: "Tiếng Việt" },
  { code: "id", name: "Bahasa Indonesia" }, { code: "tr", name: "Türkçe" }, { code: "ar", name: "العربية" },
  { code: "hi", name: "हिन्दी" }, { code: "th", name: "ไทย" }, { code: "pl", name: "Polski" }, { code: "nl", name: "Nederlands" },
];

const cache = new Map<string, string>();

/** Unicode "font changer" letters (𝐇𝐨𝐥𝐚) -> plain letters, so they translate. */
const plain = (t: string) => t.normalize("NFKC");

async function browserTranslate(texts: string[], target: string, source?: string): Promise<string[] | null> {
  const T = (globalThis as any).Translator;
  if (!T) return null;
  let src = source;
  if (!src) {
    const LD = (globalThis as any).LanguageDetector;
    if (!LD) return null;
    try {
      const det = await LD.create();
      const res = await det.detect(texts.join("\n").slice(0, 2000));
      src = res?.[0]?.detectedLanguage;
    } catch { return null; }
  }
  if (!src || src === "und") return null;
  const base = (c: string) => c.split("-")[0].toLowerCase();
  if (base(src) === base(target)) return texts;
  try {
    const avail = await T.availability({ sourceLanguage: base(src), targetLanguage: target });
    if (avail === "unavailable" || avail === "no") return null;
    const tr = await T.create({ sourceLanguage: base(src), targetLanguage: target });
    const out: string[] = [];
    for (const text of texts) {
      // Paragraph by paragraph keeps line breaks and stays under input limits.
      const parts = text.split(/(\n+)/);
      let acc = "";
      for (const p of parts) acc += /^\n+$/.test(p) || !p.trim() ? p : await tr.translate(p);
      out.push(acc);
    }
    tr.destroy?.();
    return out;
  } catch {
    return null;
  }
}

export interface TranslateResult { texts: string[]; provider: "browser" | "google" | "none" }

export async function translateTexts(texts: string[], target: string, provider: Provider, source?: string): Promise<TranslateResult> {
  const clean = texts.map(plain);
  const keys = clean.map((t) => `${target}|${t}`);
  if (keys.every((k) => cache.has(k))) return { texts: keys.map((k) => cache.get(k)!), provider: "none" };
  let out: string[] | null = null;
  let used: TranslateResult["provider"] = "google";
  if (provider !== "google") {
    out = await browserTranslate(clean, target, source);
    if (out) used = "browser";
    else if (provider === "browser") {
      throw new Error("This browser has no built-in translator for this language pair (needs Chrome 138+). "
        + "Switch the translation provider to Auto or Google on the Settings page.");
    }
  }
  if (!out) out = (await api.translate(clean, target)).translations;
  out.forEach((t, i) => cache.set(keys[i], t));
  return { texts: out, provider: used };
}

export function readTarget(fallback: string): string {
  try { return localStorage.getItem("translateTarget") || fallback; } catch { return fallback; }
}
export function saveTarget(code: string) {
  try { localStorage.setItem("translateTarget", code); } catch { /* storage blocked */ }
}
