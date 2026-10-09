import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Budget } from "@/lib/types/governance";
import { cn } from "@/lib/utils";
import {
	formatBudgetResetDuration,
	formatFiscalQuarterNote,
	formatCurrency,
	getEffectiveBudgetLimit,
	hasActiveBudgetOverride,
} from "@/lib/utils/governance";
import { useTranslation } from "react-i18next";

interface BudgetDisplayProps {
	/** A line may carry a label naming what the budget is on, for tables where lines on the same window differ by scope. */
	budgets: (Budget & { label?: string })[] | null | undefined;
	/** When true, alignable durations (day/week/month/quarter/year) get a "(calendar)" suffix. */
	calendarAligned?: boolean;
	/** Draw at most this many lines; the rest collapse into a "+x more" line whose tooltip names them. */
	maxVisible?: number;
}

/**
 * Renders a team-style usage bar per budget line: max limit + reset period on top, a
 * color-coded progress bar (emerald < 80% < amber < exhausted = red), and a tooltip with
 * the exact current/max spend. Mirrors RateLimitDisplay for visual consistency across tables.
 */
/** 展示本地化预算用量，保留预算覆盖与折叠显示规则。 */
export function BudgetDisplay({ budgets, calendarAligned, maxVisible }: BudgetDisplayProps) {
	const { t } = useTranslation("governance");
	const formatResetDuration = (duration?: string | null, aligned?: boolean) => formatBudgetResetDuration(duration, aligned, t);
	if (!budgets || budgets.length === 0) {
		return <span className="text-muted-foreground text-sm">-</span>;
	}

	const shown = maxVisible != null ? budgets.slice(0, maxVisible) : budgets;
	const hidden = maxVisible != null ? budgets.slice(maxVisible) : [];

	return (
		<div className="min-w-[160px] space-y-2.5">
			{shown.map((b, idx) => {
				const effectiveMaxLimit = getEffectiveBudgetLimit(b);
				const hasOverride = hasActiveBudgetOverride(b);
				const pct = effectiveMaxLimit > 0 ? Math.min((b.current_usage / effectiveMaxLimit) * 100, 100) : 0;
				const isExhausted = effectiveMaxLimit > 0 && b.current_usage >= effectiveMaxLimit;
				const barClass = isExhausted ? "[&>div]:bg-red-500/70" : pct > 80 ? "[&>div]:bg-amber-500/70" : "[&>div]:bg-emerald-500/70";

				return (
					<Tooltip key={b.id ?? idx}>
						<TooltipTrigger asChild>
							<div className="space-y-1.5">
								<div className="flex items-center justify-between gap-4">
									<span className="text-xs font-medium">
										{formatCurrency(effectiveMaxLimit)}
										{b.label ? <span className="text-muted-foreground ml-1 text-xs font-normal">{b.label}</span> : null}
										{hasOverride ? <span className="text-muted-foreground ml-1 text-[10px]">{t("displayUi.override")}</span> : null}
									</span>
									<span className="text-muted-foreground text-xs">
										{formatResetDuration(b.reset_duration, calendarAligned)}
										{formatFiscalQuarterNote(b.reset_duration, b.reset_config, t)}
									</span>
								</div>
								<Progress
									aria-label={t("displayUi.budgetUsage")}
									value={pct}
									className={cn("bg-muted/70 dark:bg-muted/30 h-1.5", barClass)}
								/>
							</div>
						</TooltipTrigger>
						<TooltipContent>
							<p className="font-medium">
								{formatCurrency(b.current_usage)} / {formatCurrency(effectiveMaxLimit)}
							</p>
							{hasOverride ? (
								<p className="text-muted-foreground mt-1 text-xs">
									{t("displayUi.baseOverride", { base: formatCurrency(b.max_limit), override: formatCurrency(b.override_amount ?? 0) })}
								</p>
							) : null}
							{b.reset_duration ? (
								<p className="text-muted-foreground mt-1 text-xs">
									{t("displayUi.resets", { period: formatResetDuration(b.reset_duration, calendarAligned) })}
									{formatFiscalQuarterNote(b.reset_duration, b.reset_config, t)}
								</p>
							) : null}
						</TooltipContent>
					</Tooltip>
				);
			})}
			{hidden.length > 0 ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<button type="button" className="text-muted-foreground block cursor-help text-left text-xs">
							{t("displayUi.more", { count: hidden.length })}
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{hidden.map((b, idx) => (
							<p key={b.id ?? idx} className="text-xs">
								{formatCurrency(b.current_usage)} / {formatCurrency(getEffectiveBudgetLimit(b))}
								{b.label ? ` · ${b.label}` : ""}
								{b.reset_duration ? ` · ${formatResetDuration(b.reset_duration, calendarAligned)}` : ""}
							</p>
						))}
					</TooltipContent>
				</Tooltip>
			) : null}
		</div>
	);
}