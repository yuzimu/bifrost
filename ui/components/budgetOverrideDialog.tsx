import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getErrorMessage } from "@/lib/store/apis/baseApi";
import { Budget, BudgetOverrideRequest } from "@/lib/types/governance";
import { createBudgetOverrideFormSchema } from "@/lib/types/schemas";
import { formatCurrency, getBudgetOverrideValidUntil, getEffectiveBudgetLimit, hasActiveBudgetOverride } from "@/lib/utils/governance";
import { Pencil, Plus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";

interface BudgetOverrideDialogProps {
	budget: Budget;
	onSave: (request: BudgetOverrideRequest) => Promise<void>;
	onRemove: () => Promise<void>;
	disabled?: boolean;
	calendarAligned?: boolean;
}

/** 管理已有预算的临时覆盖，按当前语言显示校验与到期日期。 */
export function BudgetOverrideDialog({ budget, onSave, onRemove, disabled, calendarAligned }: BudgetOverrideDialogProps) {
	const { t, i18n } = useTranslation("governance");
	const active = hasActiveBudgetOverride(budget);
	const [open, setOpen] = useState(false);
	const [amount, setAmount] = useState("");
	const [mode, setMode] = useState<"cycles" | "forever">("cycles");
	const [cycles, setCycles] = useState("1");
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const validUntil = mode === "cycles" ? getBudgetOverrideValidUntil(budget, Number(cycles), calendarAligned) : null;

	useEffect(() => {
		if (!open) return;
		setAmount(active ? String(budget.override_amount) : "");
		setMode(active && budget.override_mode ? budget.override_mode : "cycles");
		setCycles(active && budget.override_mode === "cycles" ? String(budget.override_cycles_remaining ?? 1) : "1");
		setError(null);
	}, [active, budget.override_amount, budget.override_cycles_remaining, budget.override_mode, open]);

	/** 校验覆盖字段后沿用原有保存入口。 */
	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		const parsedAmount = Number(amount);
		const parsedCycles = Number(cycles);
		const parsed = createBudgetOverrideFormSchema(t).safeParse({
			amount: parsedAmount,
			mode,
			...(mode === "cycles" ? { cycles: parsedCycles } : {}),
		});
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? t("overrideUi.invalidInput"));
			return;
		}

		setIsSaving(true);
		setError(null);
		try {
			await onSave({ amount: parsedAmount, mode, ...(mode === "cycles" ? { cycles: parsedCycles } : {}) });
			toast.success(active ? t("overrideUi.updated") : t("overrideUi.added"));
			setOpen(false);
		} catch (mutationError) {
			setError(getErrorMessage(mutationError));
		} finally {
			setIsSaving(false);
		}
	};

	/** 删除覆盖后显示本地化结果，保留异常消息。 */
	const handleRemove = async () => {
		setIsSaving(true);
		setError(null);
		try {
			await onRemove();
			toast.success(t("overrideUi.removed"));
			setOpen(false);
		} catch (mutationError) {
			setError(getErrorMessage(mutationError));
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 rounded-sm px-2 text-xs"
					disabled={disabled}
					data-testid={`budget-override-open-${budget.id}`}
				>
					{active ? <Pencil className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
					{active ? t("overrideUi.edit") : t("overrideUi.add")}
				</Button>
			</DialogTrigger>
			<DialogContent className="rounded-sm sm:max-w-md" data-testid={`budget-override-dialog-${budget.id}`}>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>{active ? t("overrideUi.editTitle") : t("overrideUi.addTitle")}</DialogTitle>
						<DialogDescription>{t("overrideUi.description", { base: formatCurrency(budget.max_limit) })}</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-5">
						<div className="space-y-2">
							<Label htmlFor={`budget-override-amount-${budget.id}`}>{t("overrideUi.additionalBudget")}</Label>
							<div className="relative">
								<span
									className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm"
									aria-hidden="true"
								>
									$
								</span>
								<Input
									id={`budget-override-amount-${budget.id}`}
									type="number"
									min="0.01"
									step="0.01"
									value={amount}
									onChange={(event) => setAmount(event.target.value)}
									placeholder="0.00"
									className="rounded-sm pl-7"
									disabled={isSaving}
									data-testid="budget-override-amount"
								/>
							</div>
						</div>

						<div className="space-y-2">
							<Label>{t("overrideUi.duration")}</Label>
							<Select value={mode} onValueChange={(value) => setMode(value as "cycles" | "forever")} disabled={isSaving}>
								<SelectTrigger className="w-full rounded-sm" data-testid="budget-override-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent className="rounded-sm">
									<SelectItem value="cycles">{t("overrideUi.forCycles")}</SelectItem>
									<SelectItem value="forever">{t("overrideUi.untilRemoved")}</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{mode === "cycles" ? (
							<div className="space-y-2">
								<Label htmlFor={`budget-override-cycles-${budget.id}`}>{t("overrideUi.resetCycles")}</Label>
								<Input
									id={`budget-override-cycles-${budget.id}`}
									type="number"
									min="1"
									step="1"
									value={cycles}
									onChange={(event) => setCycles(event.target.value)}
									className="rounded-sm"
									disabled={isSaving}
									data-testid="budget-override-cycles"
								/>
								<p className="text-muted-foreground text-xs">{t("overrideUi.firstCycle")}</p>
								{validUntil ? (
									<p className="text-muted-foreground text-xs">
										<Trans
											t={t}
											i18nKey="overrideUi.validUntil"
											values={{ date: validUntil.toLocaleString(i18n.resolvedLanguage) }}
											components={{ date: <span className="text-foreground font-medium" /> }}
										/>
									</p>
								) : null}
							</div>
						) : null}

						{active ? (
							<div className="bg-muted/50 rounded-sm px-3 py-2 text-xs">
								<Trans
									t={t}
									i18nKey="overrideUi.effectiveLimit"
									values={{ limit: formatCurrency(getEffectiveBudgetLimit(budget)) }}
									components={{ limit: <span className="font-medium" /> }}
								/>
							</div>
						) : null}

						{error ? (
							<p className="text-destructive text-sm" data-testid="budget-override-error">
								{error}
							</p>
						) : null}
					</div>

					<DialogFooter className="sm:justify-between">
						{active ? (
							<Button
								type="button"
								variant="destructive"
								className="rounded-sm"
								onClick={handleRemove}
								disabled={isSaving}
								data-testid="budget-override-remove"
							>
								{t("overrideUi.remove")}
							</Button>
						) : (
							<span />
						)}
						<Button type="submit" className="rounded-sm" isLoading={isSaving} data-testid="budget-override-save">
							{active ? t("overrideUi.update") : t("overrideUi.add")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}