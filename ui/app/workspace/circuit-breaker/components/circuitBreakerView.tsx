import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelector } from "@/components/ui/modelSelector";
import { ProviderSelector } from "@/components/ui/providerSelector";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TagInput } from "@/components/ui/tagInput";
import {
	useDeleteForkCircuitPolicyMutation,
	useGetForkCircuitPoliciesQuery,
	useGetForkCircuitStateQuery,
	useSaveForkCircuitPolicyMutation,
} from "@/lib/store/apis/forkFeaturesApi";
import type { CircuitPolicy, CircuitSignal } from "@/lib/types/forkFeatures";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
	ApiError,
	Choice,
	ConfirmAction,
	EditorDialog,
	FeatureHeader,
	Field,
	IconAction,
	QueryState,
	timestamp,
} from "../../guardrails/components/featurePrimitives";

const blankSignal: CircuitSignal = { source: "response_header", header_name: "" };
const blankPolicy: CircuitPolicy = {
	name: "",
	enabled: true,
	primary_provider: "",
	primary_model: "",
	primary_key_ids: [],
	fallback_provider: "",
	fallback_model: "",
	condition: { operator: "OR", signals: [{ ...blankSignal }] },
	default_cooldown: "30s",
	cooldown_header: "",
};

/** 断路器仅使用官方响应头条件与运行态，不制造探测请求或推测半开状态。 */
export function CircuitBreakerView() {
	const { t } = useTranslation("forkFeatures");
	const policies = useGetForkCircuitPoliciesQuery();
	const [poll, setPoll] = useState("5");
	const state = useGetForkCircuitStateQuery(undefined, { pollingInterval: Number(poll) * 1000, skipPollingIfUnfocused: true });
	const [save, saveState] = useSaveForkCircuitPolicyMutation();
	const [remove, removeState] = useDeleteForkCircuitPolicyMutation();
	const [editing, setEditing] = useState<CircuitPolicy | "new" | null>(null);
	const [deleting, setDeleting] = useState<CircuitPolicy | null>(null);
	const [search, setSearch] = useState("");
	const [error, setError] = useState<unknown>();
	const rows = (policies.data?.policies ?? []).filter((p) =>
		`${p.name} ${p.primary_provider} ${p.primary_model}`.toLowerCase().includes(search.toLowerCase()),
	);
	const mutate = async (policy: CircuitPolicy, name?: string) => {
		await save({ name, policy }).unwrap();
		setEditing(null);
		try {
			await policies.refetch().unwrap();
			await state.refetch().unwrap();
		} catch {
			setError(new Error(t("common.readbackFailed")));
			return;
		}
		toast.success(t("common.savedVerified"));
	};
	return (
		<div className="min-w-0 space-y-4 p-4">
			<FeatureHeader
				title={t("circuit.title")}
				busy={policies.isFetching || state.isFetching}
				refresh={() => {
					void policies.refetch();
					void state.refetch();
				}}
			>
				<Button onClick={() => setEditing("new")} disabled={policies.isLoading || !!policies.error} data-testid="circuit-create-policy">
					<Plus className="size-4" />
					{t("circuit.newPolicy")}
				</Button>
			</FeatureHeader>
			<div className="flex flex-wrap items-end gap-4">
				<Input
					className="max-w-sm"
					aria-label={t("common.search")}
					placeholder={t("common.search")}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<div className="w-52">
					<Field label={t("common.pollInterval")}>
						<Choice
							label={t("common.pollInterval")}
							value={poll}
							onChange={setPoll}
							options={["0", "5", "15", "30", "60"].map((value) => ({ value, label: value === "0" ? t("common.off") : value }))}
						/>
					</Field>
				</div>
			</div>
			<ApiError error={state.error || error} />
			<QueryState loading={policies.isLoading} error={policies.error} empty={!rows.length}>
				<Table>
					<TableHeader>
						<TableRow>
							{["name", "enabled"].map((key) => (
								<TableHead key={key}>{t(`common.${key}`)}</TableHead>
							))}
							<TableHead>{t("circuit.primary")}</TableHead>
							<TableHead>{t("circuit.fallback")}</TableHead>
							<TableHead>{t("common.status")}</TableHead>
							<TableHead>{t("circuit.cooldown")}</TableHead>
							<TableHead>{t("common.actions")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((policy) => {
							const circuit = state.data?.circuits[policy.name];
							const known = state.isSuccess && !state.error;
							return (
								<TableRow key={policy.name}>
									<TableCell className="max-w-52 break-words whitespace-normal">{policy.name}</TableCell>
									<TableCell>
										<Switch
											checked={policy.enabled}
											disabled={saveState.isLoading}
											aria-label={`${t("common.enabled")}: ${policy.name}`}
											onCheckedChange={(enabled) => {
												setError(undefined);
												void mutate({ ...policy, enabled }, policy.name).catch(setError);
											}}
											data-testid={`circuit-enabled-${policy.name}`}
										/>
									</TableCell>
									<TableCell className="max-w-52 break-words whitespace-normal">
										{policy.primary_provider}
										<br />
										<span className="text-muted-foreground text-xs">{policy.primary_model}</span>
									</TableCell>
									<TableCell className="max-w-52 break-words whitespace-normal">
										{policy.fallback_provider}
										<br />
										<span className="text-muted-foreground text-xs">{policy.fallback_model}</span>
									</TableCell>
									<TableCell>
										<div className="space-y-1">
											<span className={circuit?.status === "open" ? "text-destructive" : ""}>
												{known ? t(`circuit.${circuit?.status ?? "closed"}`) : "\u2014"}
											</span>
											{circuit?.expires_at && <p className="text-muted-foreground text-xs">{timestamp(circuit.expires_at)}</p>}
											{(policy.primary_key_ids ?? []).map((key) => {
												const sub = state.data?.circuits[`${policy.name}\u0000${key}`];
												return (
													<div key={key} className="max-w-52 text-xs break-all">
														{key}: {known ? t(`circuit.${sub?.status ?? "closed"}`) : "\u2014"}
														{sub?.expires_at && <span className="text-muted-foreground"> {timestamp(sub.expires_at)}</span>}
													</div>
												);
											})}
										</div>
									</TableCell>
									<TableCell>{policy.default_cooldown}</TableCell>
									<TableCell>
										<div className="flex">
											<IconAction label={t("common.edit")} onClick={() => setEditing(policy)}>
												<Pencil className="size-4" />
											</IconAction>
											<IconAction
												label={t("common.delete")}
												onClick={() => {
													setDeleting(policy);
													setError(undefined);
												}}
											>
												<Trash2 className="size-4" />
											</IconAction>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</QueryState>
			{editing && (
				<CircuitEditor
					key={editing === "new" ? "new" : editing.name}
					initial={editing === "new" ? undefined : editing}
					busy={saveState.isLoading}
					onClose={() => setEditing(null)}
					onSave={async (policy) => {
						await mutate(policy, editing === "new" ? undefined : editing.name);
						setEditing(null);
					}}
				/>
			)}
			<ConfirmAction
				open={!!deleting}
				title={t("common.delete")}
				description={t("common.deleteDescription", { name: deleting?.name })}
				busy={removeState.isLoading}
				error={error}
				onClose={() => setDeleting(null)}
				onConfirm={() => {
					if (!deleting) return;
					setError(undefined);
					void (async () => {
						try {
							await remove(deleting.name).unwrap();
							setDeleting(null);
							await policies.refetch().unwrap();
							await state.refetch().unwrap();
							toast.success(t("common.savedVerified"));
						} catch (err) {
							setError(err);
						}
					})();
				}}
			/>
		</div>
	);
}

/** 策略编辑保留 duration 字符串与精确的三种匹配模式，拒绝不完整的回退目标。 */
function CircuitEditor({
	initial,
	busy,
	onSave,
	onClose,
}: {
	initial?: CircuitPolicy;
	busy: boolean;
	onSave: (policy: CircuitPolicy) => Promise<void>;
	onClose: () => void;
}) {
	const { t } = useTranslation("forkFeatures");
	const [draft, setDraft] = useState<CircuitPolicy>(initial ?? blankPolicy);
	const [error, setError] = useState<unknown>();
	const set = <K extends keyof CircuitPolicy>(key: K, value: CircuitPolicy[K]) => setDraft((d) => ({ ...d, [key]: value }));
	const signals = draft.condition.signals ?? [];
	const signalSet = (index: number, value: CircuitSignal) =>
		set("condition", { ...draft.condition, signals: signals.map((signal, i) => (i === index ? value : signal)) });
	const durationValid =
		/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(draft.default_cooldown) && /\d*[1-9]\d*/.test(draft.default_cooldown);
	const valid =
		!!draft.name.trim() &&
		!!draft.primary_provider &&
		!!draft.primary_model &&
		!!draft.fallback_provider &&
		!!draft.fallback_model &&
		durationValid &&
		!!signals.length &&
		signals.every((signal) => signal.header_name.trim() && !/[\s:]/.test(signal.header_name));
	const submit = async () => {
		setError(undefined);
		try {
			await onSave(draft);
		} catch (err) {
			setError(err);
		}
	};
	return (
		<EditorDialog
			title={t(initial ? "circuit.editPolicy" : "circuit.newPolicy")}
			dirty={JSON.stringify(draft) !== JSON.stringify(initial ?? blankPolicy)}
			busy={busy}
			valid={valid}
			error={error}
			onClose={onClose}
			onSave={() => void submit()}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("common.name")} error={!draft.name.trim() ? t("common.required") : undefined}>
					<Input
						aria-label={t("common.name")}
						value={draft.name}
						disabled={!!initial}
						onChange={(e) => set("name", e.target.value)}
						maxLength={256}
						data-testid="circuit-policy-name"
					/>
				</Field>
				<Field label={t("common.enabled")}>
					<Switch checked={draft.enabled} aria-label={t("common.enabled")} onCheckedChange={(v) => set("enabled", v)} />
				</Field>
			</div>
			<section className="space-y-3 border-t pt-3">
				<h2 className="text-sm font-medium">{t("circuit.primary")}</h2>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label={t("common.provider")}>
						<ProviderSelector
							value={draft.primary_provider}
							onChange={(v: string) => {
								setDraft((d) => ({ ...d, primary_provider: v, primary_model: "", primary_key_ids: [] }));
							}}
						/>
					</Field>
					<Field label={t("common.model")}>
						<ModelSelector
							provider={draft.primary_provider}
							value={draft.primary_model}
							onChange={(v) => set("primary_model", v)}
							allowCustomModel
						/>
					</Field>
				</div>
				<Field label={t("circuit.subcircuits")}>
					<TagInput value={draft.primary_key_ids} onValueChange={(v) => set("primary_key_ids", v)} aria-label={t("circuit.subcircuits")} />
				</Field>
			</section>
			<section className="space-y-3 border-t pt-3">
				<h2 className="text-sm font-medium">{t("circuit.fallback")}</h2>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label={t("common.provider")}>
						<ProviderSelector
							value={draft.fallback_provider}
							onChange={(v: string) => setDraft((d) => ({ ...d, fallback_provider: v, fallback_model: "" }))}
						/>
					</Field>
					<Field label={t("common.model")}>
						<ModelSelector
							provider={draft.fallback_provider}
							value={draft.fallback_model}
							onChange={(v) => set("fallback_model", v)}
							allowCustomModel
						/>
					</Field>
				</div>
			</section>
			<Field label={t("circuit.operator")}>
				<Choice
					label={t("circuit.operator")}
					value={draft.condition.operator ?? "OR"}
					options={["OR", "AND"].map((value) => ({ value, label: value }))}
					onChange={(v) => set("condition", { ...draft.condition, operator: v as "OR" | "AND" })}
				/>
			</Field>
			<Field label={t("circuit.headers")} error={!signals.length ? t("circuit.signalsRequired") : undefined}>
				<div className="space-y-3">
					{signals.map((signal, index) => (
						<div key={index} className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_120px_1fr_32px]">
							<Field
								label={t("circuit.headerName")}
								error={!signal.header_name.trim() || /[\s:]/.test(signal.header_name) ? t("common.invalid") : undefined}
							>
								<Input
									value={signal.header_name}
									aria-label={t("circuit.headerName")}
									onChange={(e) => signalSet(index, { ...signal, header_name: e.target.value })}
								/>
							</Field>
							<Field label={t("circuit.match")}>
								<Choice
									value={signal.header_value !== undefined ? "equals" : signal.header_contains !== undefined ? "contains" : "exists"}
									label={t("circuit.match")}
									options={["exists", "equals", "contains"].map((value) => ({ value, label: t(`circuit.${value}`) }))}
									onChange={(v) =>
										signalSet(index, {
											source: "response_header",
											header_name: signal.header_name,
											...(v === "equals" ? { header_value: "" } : v === "contains" ? { header_contains: "" } : {}),
										})
									}
								/>
							</Field>
							<Field label={t("circuit.value")}>
								<Input
									disabled={signal.header_value === undefined && signal.header_contains === undefined}
									aria-label={t("circuit.value")}
									value={signal.header_value ?? signal.header_contains ?? ""}
									onChange={(e) =>
										signalSet(index, {
											...signal,
											...(signal.header_value !== undefined ? { header_value: e.target.value } : { header_contains: e.target.value }),
										})
									}
								/>
							</Field>
							<div className="self-end">
								<IconAction
									label={t("circuit.removeSignal")}
									onClick={() => set("condition", { ...draft.condition, signals: signals.filter((_, i) => i !== index) })}
								>
									<Trash2 className="size-4" />
								</IconAction>
							</div>
						</div>
					))}
					<Button
						type="button"
						variant="outline"
						onClick={() => set("condition", { ...draft.condition, signals: [...signals, { ...blankSignal }] })}
					>
						<Plus className="size-4" />
						{t("circuit.addSignal")}
					</Button>
				</div>
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("circuit.cooldownDuration")} error={!durationValid ? t("common.invalid") : undefined}>
					<Input
						value={draft.default_cooldown}
						aria-label={t("circuit.cooldownDuration")}
						onChange={(e) => set("default_cooldown", e.target.value)}
						placeholder="30s"
					/>
				</Field>
				<Field label={t("circuit.cooldownHeader")}>
					<Input
						value={draft.cooldown_header ?? ""}
						aria-label={t("circuit.cooldownHeader")}
						onChange={(e) => set("cooldown_header", e.target.value)}
					/>
				</Field>
			</div>
		</EditorDialog>
	);
}