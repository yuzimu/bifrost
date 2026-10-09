// Governance-related constants
import i18n, { getLocale } from "@/lib/i18n";

/** 每次读取周期标签时使用当前语言，保留周期协议值。 */
const durationLabel = (duration: string) => i18n.t(`virtualKeys.resetDurations.${duration}`, { ns: "models" });

export const resetDurationOptions = [
	{
		get label() {
			return durationLabel("1m");
		},
		value: "1m",
	},
	{
		get label() {
			return durationLabel("5m");
		},
		value: "5m",
	},
	{
		get label() {
			return durationLabel("15m");
		},
		value: "15m",
	},
	{
		get label() {
			return durationLabel("30m");
		},
		value: "30m",
	},
	{
		get label() {
			return durationLabel("1h");
		},
		value: "1h",
	},
	{
		get label() {
			return durationLabel("6h");
		},
		value: "6h",
	},
	{
		get label() {
			return durationLabel("1d");
		},
		value: "1d",
	},
	{
		get label() {
			return durationLabel("1w");
		},
		value: "1w",
	},
	{
		get label() {
			return durationLabel("1M");
		},
		value: "1M",
	},
];

// Reset periods offered on budgets. Quarterly is budget-only: resetDurationOptions
// above is shared with the rate-limit selects, and the backend has no notion of a
// quarterly token or request limit, so adding "1Q" there would offer a window it
// cannot enforce.
export const budgetResetDurationOptions = [
	...resetDurationOptions,
	{
		get label() {
			return durationLabel("1Q");
		},
		value: "1Q",
	},
];

// Durations that support calendar-aligned resets (snap to day/week/month/quarter/year boundaries).
// Must stay in sync with IsCalendarAlignableDuration in framework/configstore/tables/utils.go.
// Case matters: "M" is a month while "m" is a minute, so "1q" is not a quarter.
export const supportsCalendarAlignment = (duration: string): boolean => duration.length > 0 && /[dwMQY]$/.test(duration);

// Map of duration values to short labels for display
export const resetDurationLabels: Record<string, string> = {
	get "1m"() {
		return durationLabel("1m");
	},
	get "5m"() {
		return durationLabel("5m");
	},
	get "15m"() {
		return durationLabel("15m");
	},
	get "30m"() {
		return durationLabel("30m");
	},
	get "1h"() {
		return durationLabel("1h");
	},
	get "6h"() {
		return durationLabel("6h");
	},
	get "1d"() {
		return durationLabel("1d");
	},
	get "1w"() {
		return durationLabel("1w");
	},
	get "1M"() {
		return durationLabel("1M");
	},
	get "1Q"() {
		return durationLabel("1Q");
	},
};

/** 格式化显示月份，不改变财政季度索引与日期。 */
const monthName = (index: number, month: "short" | "long" = "short") =>
	new Date(Date.UTC(2026, index, 1)).toLocaleString(getLocale(), { month, timeZone: "UTC" });

// Fall back to January for a missing, fractional, or out-of-range month, matching
// BudgetResetConfig.QuarterStart on the Go side. Number.isInteger also rejects a
// fractional month, which would otherwise index the month tables between slots.
function normalizeQuarterStart(startMonth?: number): number {
	return startMonth !== undefined && Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
}

// Month indices (0-11) for the four fiscal quarters — the single source of the
// modulo-3 boundary math the preview string, chip ranges, and reset date all build on.
function quarterMonthIndices(startMonth?: number): { first: number; last: number }[] {
	const start = normalizeQuarterStart(startMonth);
	return [0, 1, 2, 3].map((quarter) => {
		const first = (start - 1 + quarter * 3) % 12;
		return { first, last: (first + 2) % 12 };
	});
}

/**
 * Renders the four fiscal quarters implied by a start month, e.g. April gives
 * "Q1 Apr-Jun · Q2 Jul-Sep · Q3 Oct-Dec · Q4 Jan-Mar".
 *
 * This preview is the setting's main affordance, not decoration. Quarter
 * boundaries repeat every three months, so the start month only changes reset
 * dates modulo 3: January, April, July and October all reset on the same days.
 * An operator picking "April" for a UK or Indian fiscal year would otherwise see
 * no change anywhere in the UI and reasonably conclude the setting is broken.
 * The preview shows what actually differs, which is the Q1-Q4 labelling.
 *
 * Out-of-range or missing months fall back to January, matching
 * BudgetResetConfig.QuarterStart on the Go side.
 */
/** 根据当前语言生成季度预览，保留财政季度边界。 */
export function formatQuarterPreview(startMonth?: number): string {
	return quarterMonthIndices(startMonth)
		.map((month, quarter) => `Q${quarter + 1} ${monthName(month.first)}-${monthName(month.last)}`)
		.join(" · ");
}

/**
 * Compact read-only note naming a quarterly budget's fiscal-year start, e.g.
 * " · FY starts Apr". Returns "" for non-quarterly budgets and for a January /
 * unset start (the default), so it only ever appears when it changes behaviour.
 * Callers append it after the reset-period label (which already reads "Quarterly").
 */
/** 本地化财政年度起始月份备注，默认一月仍不显示备注。 */
export function fiscalQuarterNote(resetDuration?: string, resetConfig?: { quarter_start_month?: number } | null): string {
	if (!resetDuration || !resetDuration.endsWith("Q")) return "";
	const start = resetConfig?.quarter_start_month;
	// Number.isInteger also rejects undefined/NaN; a fractional month like 2.5 would
	// otherwise pass the range check and index MONTH_ABBREVIATIONS between slots.
	if (start === undefined || !Number.isInteger(start) || start === 1 || start < 1 || start > 12) return "";
	return i18n.t("displayUi.fiscalMonth", { ns: "governance", month: monthName(start - 1) });
}

/**
 * The four fiscal quarters as `{label, range}` for the quarter-map chips, e.g.
 * April → `[{label:"Q1", range:"Apr–Jun"}, …]`. Uses an en-dash to match the design.
 */
/** 本地化季度范围中的月份，季度标签与范围值保持不变。 */
export function quarterRanges(startMonth?: number): { label: string; range: string }[] {
	return quarterMonthIndices(startMonth).map((month, quarter) => ({
		label: `Q${quarter + 1}`,
		range: `${monthName(month.first)}–${monthName(month.last)}`,
	}));
}

/** Index (0-3) of the fiscal quarter containing `now`, for the current-quarter highlight. */
export function currentQuarterIndex(startMonth?: number, now: Date = new Date()): number {
	const start = normalizeQuarterStart(startMonth);
	return Math.floor(((now.getMonth() - (start - 1) + 12) % 12) / 3);
}

/**
 * First day of the next fiscal quarter strictly after `now`, for a fiscal year
 * starting `startMonth` (1-12). Display-only — the authoritative reset schedule
 * lives in BudgetResetConfig.QuarterStart on the Go side.
 */
export function nextQuarterReset(startMonth?: number, now: Date = new Date()): Date {
	const start = normalizeQuarterStart(startMonth);
	const candidates: Date[] = [];
	for (let year = now.getFullYear() - 1; year <= now.getFullYear() + 1; year++) {
		for (let quarter = 0; quarter < 4; quarter++) {
			// A month index past 11 rolls into the next year, which is exactly the
			// wrap we want for fiscal years that start late in the calendar year.
			candidates.push(new Date(year, start - 1 + quarter * 3, 1));
		}
	}
	return candidates.filter((date) => date > now).sort((a, b) => a.getTime() - b.getTime())[0];
}

// Month choices for the fiscal quarter start select.
export const quarterStartMonthOptions = Array.from({ length: 12 }, (_, index) => ({
	get label() {
		return monthName(index, "long");
	},
	value: String(index + 1),
}));