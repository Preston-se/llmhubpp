import { getLocale } from "src/i18n";
export function settingsText(english: string, chinese: string): string { return getLocale() === "zh" ? chinese : english; }
