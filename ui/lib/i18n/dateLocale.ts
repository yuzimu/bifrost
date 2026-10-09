import { de, es, fr, it, ja, ko, pt, ru, zhCN, zhTW, type Locale } from "date-fns/locale";

const DATE_LOCALES: Record<string, Locale> = {
	"zh-CN": zhCN,
	"zh-TW": zhTW,
	ja,
	ko,
	es,
	pt,
	fr,
	de,
	it,
	ru,
};

/** 按界面语言选择日期地区设置；英文使用库默认值。 */
export function dateFnsLocale(language: string | null | undefined): Locale | undefined {
	if (!language || language === "en") return undefined;
	if (DATE_LOCALES[language]) return DATE_LOCALES[language];
	if (language.startsWith("zh-TW") || language.startsWith("zh-Hant")) return zhTW;
	if (language.startsWith("zh")) return zhCN;
	return DATE_LOCALES[language.split("-")[0]];
}
