import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
	useDeleteForkGuardrailRuleMutation,
	useEvaluateForkGuardrailsMutation,
	useGetForkGuardrailProvidersQuery,
	useGetForkGuardrailRulesQuery,
	useSaveForkGuardrailRuleMutation,
} from "@/lib/store/apis/forkFeaturesApi";
import type { GuardrailEvaluationRequest, GuardrailRule, GuardrailRuleInput } from "@/lib/types/forkFeatures";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, Choice, ConfirmAction, EditorDialog, FeatureHeader, Field, IconAction, QueryState } from "./featurePrimitives";

export function GuardrailShell({ active, children }: { active: "rules" | "providers"; children: ReactNode }) {
	const { t } = useTranslation("forkFeatures");
	return (
		<div className="min-w-0 space-y-4 p-4">
			<nav className="flex flex-wrap gap-4 border-b text-sm" aria-label={t("guardrails.title")}>
				<Link
					to="/workspace/guardrails/configuration"
					className={`py-2 ${active === "rules" ? "border-primary border-b-2 font-medium" : "text-muted-foreground"}`}
				>
					{t("guardrails.rules")}
				</Link>
				<Link
					to="/workspace/guardrails/providers"
					className={`py-2 ${active === "providers" ? "border-primary border-b-2 font-medium" : "text-muted-foreground"}`}
				>
					{t("guardrails.providers")}
				</Link>
			</nav>
			{children}
		</div>
	);
}

/** 规则列表与实际网关保持一致，变更必须在 GET 回读完成后才提示成功。 */
export function GuardrailsView() {
	const { t } = useTranslation("forkFeatures");
	const query = useGetForkGuardrailRulesQuery();
	const providers = useGetForkGuardrailProvidersQuery();
	const [save, saveState] = useSaveForkGuardrailRuleMutation();
	const [remove, removeState] = useDeleteForkGuardrailRuleMutation();
	const [editing, setEditing] = useState<GuardrailRule | "new" | null>(null);
	const [deleting, setDeleting] = useState<GuardrailRule | null>(null);
	const [error, setError] = useState<unknown>();
	const [search, setSearch] = useState("");
	const rules = (query.data?.rules ?? []).filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
	const refresh = () => {
		void query.refetch();
		void providers.refetch();
	};
	const deleteRule = async () => {
		if (!deleting) return;
		setError(undefined);
		try {
			await remove(deleting.id).unwrap();
			setDeleting(null);
			await query.refetch().unwrap();
			toast.success(t("common.savedVerified"));
		} catch (err) {
			setError(err);
		}
	};
	return (
		<GuardrailShell active="rules">
			<FeatureHeader title={t("guardrails.title")} refresh={refresh} busy={query.isFetching}>
				<Button
					data-testid="guardrail-create-rule"
					onClick={() => setEditing("new")}
					disabled={query.isLoading || providers.isLoading || !!providers.error}
				>
					<Plus className="size-4" />
					{t("guardrails.newRule")}
				</Button>
			</FeatureHeader>
			<Tabs defaultValue="rules">
				<TabsList>
					<TabsTrigger value="rules">{t("guardrails.rules")}</TabsTrigger>
					<TabsTrigger value="evaluation">{t("guardrails.evaluation")}</TabsTrigger>
				</TabsList>
				<TabsContent value="rules" className="space-y-4">
					<Input
						className="max-w-sm"
						aria-label={t("common.search")}
						placeholder={t("common.search")}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						data-testid="guardrail-rule-search"
					/>
					<ApiError error={providers.error} />
					<QueryState loading={query.isLoading} error={query.error} empty={!rules.length}>
						<Table>
							<TableHeader>
								<TableRow>
									{["name", "enabled"].map((key) => (
										<TableHead key={key}>{t(`common.${key}`)}</TableHead>
									))}
									<TableHead>{t("guardrails.target")}</TableHead>
									<TableHead>{t("guardrails.phase")}</TableHead>
									<TableHead>{t("guardrails.sampling")}</TableHead>
									<TableHead>{t("guardrails.linkedProfiles")}</TableHead>
									<TableHead>{t("common.actions")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rules.map((rule) => (
									<TableRow key={rule.id}>
										<TableCell className="max-w-64 break-words whitespace-normal">{rule.name}</TableCell>
										<TableCell>
											<Switch
												aria-label={`${t("common.enabled")}: ${rule.name}`}
												checked={rule.enabled}
												disabled={saveState.isLoading}
												data-testid={`guardrail-rule-enabled-${rule.id}`}
												onCheckedChange={(enabled) => {
													const { id, ...body } = rule;
													setError(undefined);
													void (async () => {
														try {
															await save({ id, rule: { ...body, enabled } }).unwrap();
															await query.refetch().unwrap();
															toast.success(t("common.savedVerified"));
														} catch (err) {
															setError(err);
														}
													})();
												}}
											/>
										</TableCell>
										<TableCell>{t(`guardrails.${rule.target}`)}</TableCell>
										<TableCell>{t(`guardrails.${rule.applyTo}`)}</TableCell>
										<TableCell>{rule.samplingRate}%</TableCell>
										<TableCell className="max-w-64 break-words whitespace-normal">
											{rule.selectedGuardrailProfiles
												.map((ref) => {
													const [type, id] = ref.split(":");
													return providers.data?.find((p) => p.name === type)?.configs.find((p) => p.id === Number(id))?.name ?? ref;
												})
												.join(", ")}
										</TableCell>
										<TableCell>
											<div className="flex">
												<IconAction
													label={t("common.edit")}
													onClick={() => setEditing(rule)}
													data-testid={`guardrail-rule-edit-${rule.id}`}
												>
													<Pencil className="size-4" />
												</IconAction>
												<IconAction
													label={t("common.delete")}
													onClick={() => {
														setDeleting(rule);
														setError(undefined);
													}}
													data-testid={`guardrail-rule-delete-${rule.id}`}
												>
													<Trash2 className="size-4" />
												</IconAction>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</QueryState>
				</TabsContent>
				<TabsContent value="evaluation">
					<LocalEvaluation />
				</TabsContent>
			</Tabs>
			<ApiError error={!deleting ? error : undefined} />
			{editing && (
				<RuleEditor
					key={editing === "new" ? "new" : editing.id}
					rule={editing === "new" ? undefined : editing}
					providers={providers.data ?? []}
					busy={saveState.isLoading}
					onClose={() => setEditing(null)}
					onSave={async (rule) => {
						await save({ id: editing === "new" ? undefined : editing.id, rule }).unwrap();
						setEditing(null);
						try {
							await query.refetch().unwrap();
						} catch {
							setError(new Error(t("common.readbackFailed")));
							return;
						}
						toast.success(t("common.savedVerified"));
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
				onConfirm={() => void deleteRule()}
			/>
		</GuardrailShell>
	);
}

/** 表单按官方 camelCase 规则契约提交完整替换，关联配置保持显式顺序。 */
function RuleEditor({
	rule,
	providers,
	busy,
	onSave,
	onClose,
}: {
	rule?: GuardrailRule;
	providers: { name: string; configs: { id: number; name: string; enabled: boolean }[] }[];
	busy: boolean;
	onSave: (rule: GuardrailRuleInput) => Promise<void>;
	onClose: () => void;
}) {
	const { t } = useTranslation("forkFeatures");
	const initial: GuardrailRuleInput = rule
		? (({ id: _id, ...rest }) => ({
				...rest,
				description: rest.description ?? "",
				sendAllConversationTurns: rest.sendAllConversationTurns ?? (rest.maxTurnsToSend ?? 0) === 0,
				maxTurnsToSend: rest.maxTurnsToSend ?? 0,
				evaluationMode: rest.evaluationMode ?? "bundled",
				streamReplayEventIntervalMs: rest.streamReplayEventIntervalMs ?? 0,
			}))(rule)
		: {
				name: "",
				description: "",
				enabled: true,
				target: "llm",
				celExpression: "true",
				applyTo: "input",
				samplingRate: 100,
				timeout: 60,
				selectedGuardrailProfiles: [],
				sendAllConversationTurns: true,
				maxTurnsToSend: 0,
				evaluationMode: "bundled",
				streamReplayEventIntervalMs: 0,
			};
	const [draft, setDraft] = useState(initial);
	const [error, setError] = useState<unknown>();
	const set = <K extends keyof GuardrailRuleInput>(key: K, value: GuardrailRuleInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
	const numberError = (value: number | undefined, min: number, max: number) =>
		value !== undefined && Number.isInteger(value) && value >= min && value <= max ? undefined : t("common.invalidNumber", { min, max });
	const valid =
		!!draft.name.trim() &&
		!!draft.celExpression.trim() &&
		!!draft.selectedGuardrailProfiles.length &&
		!numberError(draft.samplingRate, 0, 100) &&
		!numberError(draft.timeout, 1, 3600) &&
		!numberError(draft.maxTurnsToSend ?? 0, 0, 10000) &&
		!numberError(draft.streamReplayEventIntervalMs ?? 0, 0, 1000);
	const move = (index: number, step: number) => {
		const ids = [...draft.selectedGuardrailProfiles];
		[ids[index], ids[index + step]] = [ids[index + step], ids[index]];
		set("selectedGuardrailProfiles", ids);
	};
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
			title={t(rule ? "guardrails.editRule" : "guardrails.newRule")}
			dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
			busy={busy}
			error={error}
			onClose={onClose}
			onSave={() => void submit()}
			valid={valid}
		>
			<div className="grid min-w-0 gap-4 sm:grid-cols-2">
				<Field label={t("common.name")} error={!draft.name.trim() ? t("common.required") : undefined}>
					<Input
						value={draft.name}
						maxLength={256}
						onChange={(e) => set("name", e.target.value)}
						aria-label={t("common.name")}
						data-testid="guardrail-rule-name"
					/>
				</Field>
				<Field label={t("common.enabled")}>
					<Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label={t("common.enabled")} />
				</Field>
				<Field label={t("guardrails.target")}>
					<Choice
						label={t("guardrails.target")}
						value={draft.target}
						onChange={(v) => set("target", v as GuardrailRuleInput["target"])}
						options={["llm", "mcp"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
					/>
				</Field>
				<Field label={t("guardrails.phase")}>
					<Choice
						label={t("guardrails.phase")}
						value={draft.applyTo}
						onChange={(v) => set("applyTo", v as GuardrailRuleInput["applyTo"])}
						options={["input", "output", "both"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
					/>
				</Field>
			</div>
			<Field label={t("common.description")}>
				<Textarea
					aria-label={t("common.description")}
					value={draft.description ?? ""}
					onChange={(e) => set("description", e.target.value)}
				/>
			</Field>
			<Field label={t("guardrails.cel")} error={!draft.celExpression.trim() ? t("common.required") : undefined}>
				<Textarea
					className="font-mono text-xs"
					aria-label={t("guardrails.cel")}
					value={draft.celExpression}
					onChange={(e) => set("celExpression", e.target.value)}
					maxLength={8192}
					data-testid="guardrail-rule-cel"
				/>
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				{(
					[
						{ key: "samplingRate", label: "sampling", min: 0, max: 100 },
						{ key: "timeout", label: "timeout", min: 1, max: 3600 },
					] as const
				).map((f) => (
					<Field key={f.key} label={t(`guardrails.${f.label}`)} error={numberError(draft[f.key], f.min, f.max)}>
						<Input
							type="number"
							step={1}
							min={f.min}
							max={f.max}
							value={Number.isNaN(draft[f.key]) ? "" : draft[f.key]}
							onChange={(e) => set(f.key, e.target.valueAsNumber)}
							aria-label={t(`guardrails.${f.label}`)}
						/>
					</Field>
				))}
			</div>
			<Field
				label={t("guardrails.linkedProfiles")}
				error={!draft.selectedGuardrailProfiles.length ? t("guardrails.profileRequired") : undefined}
			>
				<div className="space-y-2">
					{providers.flatMap((provider) =>
						provider.configs.map((profile) => {
							const ref = `${provider.name}:${profile.id}`;
							return (
								<label key={ref} className="flex min-w-0 items-center gap-2 text-sm">
									<Checkbox
										checked={draft.selectedGuardrailProfiles.includes(ref)}
										onCheckedChange={(checked) =>
											set(
												"selectedGuardrailProfiles",
												checked ? [...draft.selectedGuardrailProfiles, ref] : draft.selectedGuardrailProfiles.filter((id) => id !== ref),
											)
										}
									/>
									<span className="break-words">
										{profile.name}{" "}
										<span className="text-muted-foreground">
											({provider.name}
											{!profile.enabled ? `, ${t("common.disabled")}` : ""})
										</span>
									</span>
								</label>
							);
						}),
					)}
				</div>
			</Field>
			{draft.selectedGuardrailProfiles.length > 1 && (
				<Field label={t("guardrails.linkedOrder")}>
					<ol className="space-y-1">
						{draft.selectedGuardrailProfiles.map((ref, index) => (
							<li key={ref} className="flex items-center gap-2 text-xs">
								<span className="mr-auto">{ref}</span>
								<IconAction label={t("guardrails.moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
									<ArrowUp className="size-3" />
								</IconAction>
								<IconAction
									label={t("guardrails.moveDown")}
									disabled={index === draft.selectedGuardrailProfiles.length - 1}
									onClick={() => move(index, 1)}
								>
									<ArrowDown className="size-3" />
								</IconAction>
							</li>
						))}
					</ol>
				</Field>
			)}
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("guardrails.allTurns")}>
					<Switch
						aria-label={t("guardrails.allTurns")}
						checked={draft.sendAllConversationTurns ?? true}
						onCheckedChange={(v) => set("sendAllConversationTurns", v)}
					/>
				</Field>
				{!draft.sendAllConversationTurns && (
					<Field label={t("guardrails.maxTurns")} error={numberError(draft.maxTurnsToSend ?? 0, 0, 10000)}>
						<Input
							aria-label={t("guardrails.maxTurns")}
							type="number"
							min={0}
							max={10000}
							step={1}
							value={draft.maxTurnsToSend ?? 0}
							onChange={(e) => set("maxTurnsToSend", e.target.valueAsNumber)}
						/>
					</Field>
				)}
				<Field label={t("guardrails.evaluationMode")}>
					<Choice
						value={draft.evaluationMode ?? "bundled"}
						label={t("guardrails.evaluationMode")}
						onChange={(v) => set("evaluationMode", v as "bundled" | "per_turn")}
						options={["bundled", "per_turn"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
					/>
				</Field>
				<Field label={t("guardrails.replayMs")} error={numberError(draft.streamReplayEventIntervalMs ?? 0, 0, 1000)}>
					<Input
						aria-label={t("guardrails.replayMs")}
						type="number"
						step={1}
						min={0}
						max={1000}
						value={draft.streamReplayEventIntervalMs ?? 0}
						onChange={(e) => set("streamReplayEventIntervalMs", e.target.valueAsNumber)}
					/>
				</Field>
			</div>
		</EditorDialog>
	);
}

/** 本地入口使用服务端可信 scope，既不调用评判模型也不持久化用户输入。 */
function LocalEvaluation() {
	const { t } = useTranslation("forkFeatures");
	const [draft, setDraft] = useState<GuardrailEvaluationRequest>({ text: "", target: "llm", phase: "input" });
	const [evaluate, state] = useEvaluateForkGuardrailsMutation();
	const set = <K extends keyof GuardrailEvaluationRequest>(key: K, value: GuardrailEvaluationRequest[K]) => {
		state.reset();
		setDraft((d) => ({ ...d, [key]: value }));
	};
	return (
		<div className="max-w-3xl space-y-4 pt-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("guardrails.target")}>
					<Choice
						label={t("guardrails.target")}
						value={draft.target}
						onChange={(v) => set("target", v as "llm" | "mcp")}
						options={["llm", "mcp"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
					/>
				</Field>
				<Field label={t("guardrails.phase")}>
					<Choice
						label={t("guardrails.phase")}
						value={draft.phase}
						onChange={(v) => set("phase", v as "input" | "output")}
						options={["input", "output"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
					/>
				</Field>
			</div>
			<Field label={t("guardrails.text")}>
				<Textarea
					aria-label={t("guardrails.text")}
					rows={6}
					value={draft.text}
					onChange={(e) => set("text", e.target.value)}
					autoComplete="off"
					data-testid="guardrail-evaluation-content"
				/>
			</Field>
			<Button
				disabled={!draft.text.trim() || state.isLoading}
				onClick={() => {
					void evaluate(draft);
				}}
				data-testid="guardrail-local-evaluate"
			>
				<FlaskConical className="size-4" />
				{t("guardrails.evaluate")}
			</Button>
			<ApiError error={state.error} />
			{state.data && (
				<section className="space-y-3 border-t pt-4" aria-live="polite">
					<dl className="grid grid-cols-2 gap-4 text-sm">
						<div>
							<dt className="text-muted-foreground text-xs">{t("guardrails.decision")}</dt>
							<dd>{t(state.data.blocked ? "guardrails.blocked" : "guardrails.allow")}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground text-xs">{t("guardrails.detections")}</dt>
							<dd>{state.data.metadata?.detections?.length ?? (state.data.blocked ? "\u2014" : 0)}</dd>
						</div>
					</dl>
					<Field label={t("guardrails.result")}>
						<pre className="bg-muted/30 max-h-72 overflow-auto rounded-md border p-3 text-xs break-words whitespace-pre-wrap">
							{state.data.texts?.join("\n") ?? t("guardrails.blocked")}
						</pre>
					</Field>
					{state.data.metadata?.detections?.map((d, i) => (
						<p key={i} className="text-xs break-words">
							{d.rule_name} / {d.guardrail_name}: {d.assessments?.join(", ")}
						</p>
					))}
					{state.data.reason && <p className="text-sm break-words">{state.data.reason}</p>}
				</section>
			)}
		</div>
	);
}