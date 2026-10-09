import i18n, { getLocale } from "@/lib/i18n";
import { budgetOverrideFormSchema } from "@/lib/types/schemas";
import { formatCompactNumber } from "./numbers";
import type { TFunction } from "i18next";
import { fiscalQuarterNote, resetDurationLabels, supportsCalendarAlignment } from "@/lib/constants/governance";

/** 按当前语言显示周期长度，未知协议值保持原样。 */
export function parseResetPeriod(duration: string): string {
	if (!duration) return i18n.t("displayUi.unknownPeriod", { ns: "governance" });

	const timeValue = parseInt(duration.slice(0, -1));
	const timeUnit = duration.slice(-1);

	const unitMap: Record<string, string> = {
		s: "seconds",
		m: "minutes",
		h: "hours",
		d: "days",
		w: "weeks",
		M: "months",
		Q: "quarters",
		y: "years",
		Y: "years",
	};

	const unit = unitMap[timeUnit];
	if (!unit) return duration;

	return i18n.t(`displayUi.duration.${unit}`, { ns: "governance", count: timeValue });
}

/** 翻译预算周期显示，未知周期与协议值保持原样。 */
export function formatBudgetResetDuration(duration?: string | null, calendarAligned?: boolean, t?: TFunction): string {
	if (!duration) return "";
	const fallback = resetDurationLabels[duration] || duration;
	const translate = t ?? i18n.t.bind(i18n);
	const period = translate(`displayUi.periods.${duration}`, {
		ns: "governance",
		defaultValue: fallback,
	});
	return calendarAligned && supportsCalendarAlignment(duration)
		? translate("displayUi.calendarPeriod", { ns: "governance", period })
		: period;
}

/** 翻译财政季度备注，不改变重置日期的计算。 */
export function formatFiscalQuarterNote(duration?: string, resetConfig?: { quarter_start_month?: number } | null, t?: TFunction): string {
	const note = fiscalQuarterNote(duration, resetConfig);
	if (!note || !t) return note;
	const month = new Date(Date.UTC(2026, (resetConfig?.quarter_start_month ?? 1) - 1, 1)).toLocaleString(getLocale(), {
		month: "short",
		timeZone: "UTC",
	});
	return t("displayUi.fiscalMonth", { ns: "governance", month });
}

export function formatCurrency(dollars: number) {
	return `$${dollars.toFixed(2)}`;
}

export interface BudgetOverrideFields {
	max_limit: number;
	override_amount?: number;
	override_mode?: "cycles" | "forever";
	override_cycles_remaining?: number;
}

/** Returns whether a budget has a complete, currently active override. */
export function hasActiveBudgetOverride(budget: BudgetOverrideFields): boolean {
	if (!budget.override_amount || budget.override_amount <= 0) return false;
	return budget.override_mode === "forever" || (budget.override_mode === "cycles" && (budget.override_cycles_remaining ?? 0) > 0);
}

/** Returns the base limit plus the active additive override. */
export function getEffectiveBudgetLimit(budget: BudgetOverrideFields): number {
	return budget.max_limit + (hasActiveBudgetOverride(budget) ? (budget.override_amount ?? 0) : 0);
}

/** Validates the operator-entered override fields before sending them to the API. Delegates to budgetOverrideFormSchema. */
export function validateBudgetOverride(amount: number, mode: "cycles" | "forever", cycles: number): string | null {
	const result = budgetOverrideFormSchema.safeParse({
		amount,
		mode,
		...(mode === "cycles" ? { cycles } : {}),
	});
	return result.success ? null : (result.error.issues[0]?.message ?? "Invalid input");
}

/**
 * Adds months in UTC, clamping to the target month's last day instead of letting
 * JS Date overflow spill into the following month (e.g. Jan 31 + 1M = Feb 28/29).
 */
function addUTCMonthsClamped(date: Date, months: number): void {
	const day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + months);
	const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, lastDay));
}

/** Snaps a calendar-aligned reset timestamp to its UTC period boundary. */
function snapToCalendarPeriodStart(date: Date, unit: string): void {
	switch (unit) {
		case "d":
			date.setUTCHours(0, 0, 0, 0);
			break;
		case "w": {
			date.setUTCHours(0, 0, 0, 0);
			const daysFromMonday = (date.getUTCDay() + 6) % 7;
			date.setUTCDate(date.getUTCDate() - daysFromMonday);
			break;
		}
		case "M":
			date.setUTCDate(1);
			date.setUTCHours(0, 0, 0, 0);
			break;
		case "y":
		case "Y":
			date.setUTCMonth(0, 1);
			date.setUTCHours(0, 0, 0, 0);
			break;
	}
}

/** Calculates when a cycle-based override will expire on the budget's current reset schedule. */
export function getBudgetOverrideValidUntil(
	budget: Pick<BudgetOverrideFields, "max_limit"> & { last_reset: string; reset_duration: string },
	cycles: number,
	calendarAligned = false,
): Date | null {
	if (!Number.isSafeInteger(cycles) || cycles <= 0) return null;
	const match = /^(\d+)([smhdwMQyY])$/.exec(budget.reset_duration);
	const validUntil = new Date(budget.last_reset);
	if (!match || Number.isNaN(validUntil.getTime())) return null;

	const unit = match[2];
	if (calendarAligned) snapToCalendarPeriodStart(validUntil, unit);
	const durationValue = Number(match[1]) * cycles;
	switch (unit) {
		case "s":
			validUntil.setTime(validUntil.getTime() + durationValue * 1000);
			break;
		case "m":
			validUntil.setTime(validUntil.getTime() + durationValue * 60 * 1000);
			break;
		case "h":
			validUntil.setTime(validUntil.getTime() + durationValue * 60 * 60 * 1000);
			break;
		case "d":
			validUntil.setUTCDate(validUntil.getUTCDate() + durationValue);
			break;
		case "w":
			validUntil.setUTCDate(validUntil.getUTCDate() + durationValue * 7);
			break;
		case "M":
			if (calendarAligned) {
				addUTCMonthsClamped(validUntil, durationValue);
			} else {
				validUntil.setTime(validUntil.getTime() + durationValue * 30 * 24 * 60 * 60 * 1000);
			}
			break;
		case "Q":
			// A calendar quarter is exactly three months; a rolling one is the 90-day
			// approximation ParseDuration uses on the Go side.
			if (calendarAligned) {
				addUTCMonthsClamped(validUntil, durationValue * 3);
			} else {
				validUntil.setTime(validUntil.getTime() + durationValue * 90 * 24 * 60 * 60 * 1000);
			}
			break;
		case "y":
		case "Y":
			if (calendarAligned) {
				addUTCMonthsClamped(validUntil, durationValue * 12);
			} else {
				validUntil.setTime(validUntil.getTime() + durationValue * 365 * 24 * 60 * 60 * 1000);
			}
			break;
	}
	return Number.isNaN(validUntil.getTime()) ? null : validUntil;
}

const shortDurationKeys = new Set(["1m", "5m", "15m", "30m", "1h", "6h", "1d", "1w", "1M"]);

/** 本地化速率限制摘要，不改变数值、单位周期和限制规则。 */
export function formatRateLimitLines(
	rateLimits:
		| {
				token_max_limit?: number | null;
				token_reset_duration?: string | null;
				request_max_limit?: number | null;
				request_reset_duration?: string | null;
		  }
		| null
		| undefined,
): string[] {
	if (!rateLimits) return [];
	const lines: string[] = [];
	if (rateLimits.token_max_limit != null) {
		const duration = rateLimits.token_reset_duration ?? "";
		const suffix = duration
			? `/${shortDurationKeys.has(duration) ? i18n.t(`displayUi.shortPeriods.${duration}`, { ns: "governance" }) : duration}`
			: "";
		lines.push(`${formatCompactNumber(rateLimits.token_max_limit)} ${i18n.t("displayUi.tokens", { ns: "governance" })}${suffix}`);
	}
	if (rateLimits.request_max_limit != null) {
		const duration = rateLimits.request_reset_duration ?? "";
		const suffix = duration
			? `/${shortDurationKeys.has(duration) ? i18n.t(`displayUi.shortPeriods.${duration}`, { ns: "governance" }) : duration}`
			: "";
		lines.push(`${formatCompactNumber(rateLimits.request_max_limit)} ${i18n.t("displayUi.requests", { ns: "governance" })}${suffix}`);
	}
	return lines;
}

/**
 * Calculates usage percentage for rate limits
 */
export function calculateUsagePercentage(current: number, max: number): number {
	if (max === 0) return 0;
	return Math.round((current / max) * 100);
}

/**
 * Gets the appropriate variant for usage percentage badges
 */
export function getUsageVariant(percentage: number): "default" | "secondary" | "destructive" | "outline" {
	if (percentage >= 90) return "destructive";
	if (percentage >= 75) return "secondary";
	return "default";
}
/** A budget reduced to the fields that decide whether its reset window moved. */
export interface BudgetComparisonEntry {
	id?: string;
	max_limit?: number;
	reset_duration?: string;
	reset_config?: { quarter_start_month?: number };
	current_usage?: number;
}

/** Normalised fiscal quarter start; absent and an explicit January are the same window. */
export const quarterStartOf = (entry: Pick<BudgetComparisonEntry, "reset_config">) => entry.reset_config?.quarter_start_month || 1;

/**
 * A stable string describing every budget setting that moves a reset boundary.
 *
 * The fiscal quarter start belongs here for quarterly budgets: April and July
 * are the same limit on the same 1Q cadence and differ only in when the window
 * turns over, so a signature built from limit and duration alone reports "no
 * change" for precisely the edit that reschedules the reset.
 */
export const budgetSignature = (budgets?: BudgetComparisonEntry[]) =>
	(budgets || [])
		.filter((budget) => budget.max_limit !== undefined)
		.map((budget) => {
			const quarterStart = budget.reset_duration?.endsWith("Q") ? quarterStartOf(budget) : "";
			return `${budget.id ?? ""}:${budget.max_limit}:${budget.reset_duration ?? ""}:${quarterStart}`;
		})
		.sort()
		.join("|");

export type GovernanceAction = "create" | "edit" | "delete" | "rotate";

/** 本地化权限禁用原因；业务禁用原因仍优先，不改变权限判断。 */
export function actionDisabledReason(
	allowed: boolean,
	action: GovernanceAction,
	entityPlural: string,
	blockedReason?: string,
): string | undefined {
	if (blockedReason) return blockedReason;
	if (allowed) return undefined;
	const entities: Record<string, string> = {
		"virtual keys": "virtualKeys",
		"model limits": "modelLimits",
		teams: "teams",
		customers: "customers",
	};
	const entity = entities[entityPlural]
		? i18n.t(`displayUi.permissionEntities.${entities[entityPlural]}`, { ns: "governance" })
		: entityPlural;
	return i18n.t("displayUi.permissionDenied", {
		ns: "governance",
		action: i18n.t(`displayUi.permissionActions.${action}`, { ns: "governance" }),
		entity,
	});
}