import { CopyableId } from "@/components/copyableId";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Customer } from "@/lib/types/governance";
import { cn } from "@/lib/utils";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

interface Props {
	customer: Customer | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** 本地化已知重置周期，未知周期保留服务端原值。 */
function formatResetDuration(duration: string | null | undefined, t: TFunction<"enterprise">): string {
	if (!duration) return "";
	return t(`customer.resetDuration.${duration}`, { defaultValue: duration });
}

/** 仅对非默认的有效季度起始月份显示本地化财年说明。 */
function formatFiscalQuarterNote(
	resetDuration: string | undefined,
	resetConfig: { quarter_start_month?: number } | undefined,
	t: TFunction<"enterprise">,
	locale: string,
): string {
	if (!resetDuration?.endsWith("Q")) return "";
	const start = resetConfig?.quarter_start_month;
	if (start === undefined || !Number.isInteger(start) || start === 1 || start < 1 || start > 12) return "";
	const month = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, start - 1, 1)));
	return t("customer.fiscalYearStart", { month });
}

function formatCurrency(value: number): string {
	return `$${value.toFixed(2)}`;
}

function DetailCard({ title, children, contentClassName }: { title: string; children: React.ReactNode; contentClassName?: string }) {
	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">{title}</h3>
			</div>
			<div className={cn("rounded-md border px-4 py-3", contentClassName)}>{children}</div>
		</div>
	);
}

/** 展示预算用量，并随界面语言更新周期与财年说明。 */
function BudgetLineBar({
	current,
	max,
	resetDuration,
	resetConfig,
}: {
	current: number;
	max: number;
	resetDuration?: string;
	resetConfig?: { quarter_start_month?: number };
}) {
	const { t, i18n } = useTranslation("enterprise");
	const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
	const isOver80 = pct >= 80;
	const isOver100 = pct >= 100;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between text-xs">
				<span className="font-medium" />
				<span className="text-muted-foreground">
					{formatResetDuration(resetDuration, t)}
					{formatFiscalQuarterNote(resetDuration, resetConfig, t, i18n.resolvedLanguage ?? i18n.language)}
				</span>
			</div>
			<div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
				<div
					className={`h-full rounded-full transition-all ${isOver100 ? "bg-destructive" : isOver80 ? "bg-orange-500" : "bg-primary"}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<div className="text-muted-foreground flex items-center justify-between text-xs">
				<span>
					{formatCurrency(current)} / {formatCurrency(max)}
				</span>
				<span>{pct.toFixed(0)}%</span>
			</div>
		</div>
	);
}

/** 展示速率用量，周期与紧凑数字格式使用当前界面语言。 */
function RateLimitBar({ label, current, max, resetDuration }: { label: string; current: number; max: number; resetDuration?: string }) {
	const { t, i18n } = useTranslation("enterprise");
	const numberFormatter = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
		notation: "compact",
		compactDisplay: "short",
		maximumFractionDigits: 2,
	});
	const pct = max > 0 ? Math.min((current / max) * 100, 100) : 0;
	const isOver80 = pct >= 80;
	const isOver100 = pct >= 100;
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between text-xs">
				<span>{label}</span>
				<span className="text-muted-foreground">{formatResetDuration(resetDuration, t)}</span>
			</div>
			<div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
				<div
					className={`h-full rounded-full transition-all ${isOver100 ? "bg-destructive" : isOver80 ? "bg-orange-500" : "bg-primary"}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<div className="text-muted-foreground flex items-center justify-between text-xs">
				<span>
					{numberFormatter.format(Number.isFinite(current) ? current : 0)} / {numberFormatter.format(Number.isFinite(max) ? max : 0)}
				</span>
				<span>{pct.toFixed(0)}%</span>
			</div>
		</div>
	);
}

/** 使用已有客户数据展示 OSS 详情，不请求企业版专属信息。 */
export function CustomerDetailSheet({ customer, open, onOpenChange }: Props) {
	const { t } = useTranslation("enterprise");
	const budgets = customer?.budgets ?? [];
	const rateLimit = customer?.rate_limit;
	const hasRateLimit = rateLimit?.token_max_limit != null || rateLimit?.request_max_limit != null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="max-w-[700px] overflow-y-auto p-0 pt-4">
				<SheetHeader className="flex flex-col items-start px-0 py-4" headerClassName="mb-0 px-4 md:px-8 sticky -top-4 bg-card z-10">
					<div className="flex min-w-0 items-center gap-1">
						<SheetTitle className="truncate text-lg">{customer?.name || t("customer.title")}</SheetTitle>
						{customer?.id && <CopyableId id={customer.id} entityLabel={t("customer.entity")} />}
					</div>
					<SheetDescription>{t("customer.description")}</SheetDescription>
				</SheetHeader>

				{customer && (
					<div className="space-y-6 px-4 py-4 md:px-8">
						{/* ── Info ─────────────────────────────────────────── */}
						<DetailCard title={t("customer.info")}>
							<div className="grid grid-cols-2 gap-x-8 gap-y-4">
								<div>
									<Label className="text-muted-foreground text-xs">{t("customer.name")}</Label>
									<p className="mt-0.5 text-sm">{customer.name ?? "—"}</p>
								</div>
							</div>
						</DetailCard>

						{/* ── Budgets ──────────────────────────────────────── */}
						<DetailCard title={t("customer.budgets")}>
							{budgets.length > 0 ? (
								<div className="space-y-3">
									{[...budgets]
										.sort((a, b) => (b.max_limit || 0) - (a.max_limit || 0))
										.map((b) => (
											<BudgetLineBar
												key={b.id}
												current={b.current_usage}
												max={b.max_limit}
												resetDuration={b.reset_duration}
												resetConfig={b.reset_config}
											/>
										))}
								</div>
							) : (
								<p className="text-muted-foreground py-1 text-center text-sm">{t("customer.noBudgets")}</p>
							)}
						</DetailCard>

						{/* ── Rate Limits ──────────────────────────────────── */}
						<DetailCard title={t("customer.rateLimits")}>
							{rateLimit && hasRateLimit ? (
								<div className="space-y-3">
									{rateLimit.token_max_limit != null && (
										<RateLimitBar
											label={t("customer.tokens")}
											current={rateLimit.token_current_usage ?? 0}
											max={rateLimit.token_max_limit}
											resetDuration={rateLimit.token_reset_duration}
										/>
									)}
									{rateLimit.request_max_limit != null && (
										<RateLimitBar
											label={t("customer.requests")}
											current={rateLimit.request_current_usage ?? 0}
											max={rateLimit.request_max_limit}
											resetDuration={rateLimit.request_reset_duration}
										/>
									)}
								</div>
							) : (
								<p className="text-muted-foreground py-1 text-center text-sm">{t("customer.noRateLimits")}</p>
							)}
						</DetailCard>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}

export default CustomerDetailSheet;