import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getErrorMessage } from "@/lib/store/apis/baseApi";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function IconAction({
	label,
	children,
	...props
}: {
	label: string;
	children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "children">) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label={label} {...props}>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
	const id = useId();
	return (
		<div className="min-w-0 space-y-1.5" role="group" aria-labelledby={id}>
			<Label id={id} className="text-xs">
				{label}
			</Label>
			{children}
			{error && (
				<p role="alert" className="text-destructive text-xs break-words">
					{error}
				</p>
			)}
		</div>
	);
}

export function Choice({
	value,
	onChange,
	options,
	label,
	disabled,
}: {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
	label: string;
	disabled?: boolean;
}) {
	return (
		<Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger aria-label={label} data-testid={`fork-select-${label}`} className="w-full min-w-0">
				<SelectValue placeholder={label} />
			</SelectTrigger>
			<SelectContent>
				{options
					.filter((o) => o.value)
					.map((o) => (
						<SelectItem key={o.value} value={o.value}>
							{o.label}
						</SelectItem>
					))}
			</SelectContent>
		</Select>
	);
}

export function ApiError({ error }: { error?: unknown }) {
	const data = error && typeof error === "object" && "data" in error ? error.data : undefined;
	const message =
		data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : getErrorMessage(error);
	return error ? (
		<div role="alert" className="border-destructive/40 text-destructive rounded-md border p-3 text-sm break-words">
			{message}
		</div>
	) : null;
}

export function QueryState({
	loading,
	error,
	empty,
	children,
}: {
	loading: boolean;
	error?: unknown;
	empty: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation("forkFeatures");
	if (loading)
		return (
			<div role="status" className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
				<Loader2 className="size-4 animate-spin" />
				{t("common.loading")}
			</div>
		);
	if (error) return <ApiError error={error} />;
	if (empty) return <div className="text-muted-foreground border-y py-12 text-center text-sm">{t("common.empty")}</div>;
	return children;
}

export function FeatureHeader({
	title,
	children,
	refresh,
	busy,
}: {
	title: string;
	children?: ReactNode;
	refresh?: () => void;
	busy?: boolean;
}) {
	const { t } = useTranslation("forkFeatures");
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
			<h1 className="min-w-0 text-lg font-semibold break-words">{title}</h1>
			<div className="flex flex-wrap items-center gap-2">
				{refresh && (
					<IconAction label={t("common.refresh")} onClick={refresh} disabled={busy}>
						<RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
					</IconAction>
				)}
				{children}
			</div>
		</div>
	);
}

export function ConfirmAction({
	open,
	title,
	description,
	busy,
	error,
	onClose,
	onConfirm,
}: {
	open: boolean;
	title: string;
	description: string;
	busy?: boolean;
	error?: unknown;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation("forkFeatures");
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onClose();
			}}
		>
			<DialogContent showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle className="break-words">{title}</DialogTitle>
					<DialogDescription className="break-words">{description}</DialogDescription>
				</DialogHeader>
				<ApiError error={error} />
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button disabled={busy} onClick={onConfirm} data-testid="fork-confirm-action">
						{busy && <Loader2 className="size-4 animate-spin" />}
						{t("common.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 编辑中的草稿只在显式保存或确认丢弃时关闭，未保存状态不被后台刷新覆盖。 */
export function EditorDialog({
	title,
	dirty,
	busy,
	error,
	children,
	onClose,
	onSave,
	valid = true,
}: {
	title: string;
	dirty: boolean;
	busy: boolean;
	error?: unknown;
	children: ReactNode;
	onClose: () => void;
	onSave: () => void;
	valid?: boolean;
}) {
	const { t } = useTranslation("forkFeatures");
	const [discard, setDiscard] = useState(false);
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty]);
	const close = () => {
		if (busy) return;
		if (dirty) setDiscard(true);
		else onClose();
	};
	return (
		<>
			<Dialog
				open
				onOpenChange={(next) => {
					if (!next) close();
				}}
			>
				<DialogContent className="sm:max-w-2xl" showCloseButton={!busy}>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription className="sr-only">{title}</DialogDescription>
					</DialogHeader>
					<fieldset disabled={busy} className="min-w-0 space-y-4">
						{children}
					</fieldset>
					<ApiError error={error} />
					<DialogFooter>
						<span className="text-muted-foreground mr-auto self-center text-xs">{dirty ? t("common.unsaved") : t("common.saved")}</span>
						<Button variant="outline" disabled={busy} onClick={close}>
							{t("common.cancel")}
						</Button>
						<Button disabled={busy || !dirty || !valid} onClick={onSave} data-testid="fork-save">
							{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
							{t("common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<ConfirmAction
				open={discard}
				title={t("common.discard")}
				description={t("common.discardDescription")}
				onClose={() => setDiscard(false)}
				onConfirm={onClose}
			/>
		</>
	);
}

export function timestamp(value?: string) {
	return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "\u2014";
}