import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ModelSelector } from "@/components/ui/modelSelector";
import { ProviderSelector } from "@/components/ui/providerSelector";
import { SecretVarInput } from "@/components/ui/secretVarInput";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TagInput } from "@/components/ui/tagInput";
import { Textarea } from "@/components/ui/textarea";
import {
	useDeleteForkGuardrailProfileMutation,
	useGetForkGuardrailProvidersQuery,
	useSaveForkGuardrailProfileMutation,
} from "@/lib/store/apis/forkFeaturesApi";
import type {
	GuardrailAction,
	GuardrailCapability,
	GuardrailPattern,
	GuardrailProfile,
	GuardrailProfileConfig,
} from "@/lib/types/forkFeatures";
import { Info, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, Choice, ConfirmAction, EditorDialog, FeatureHeader, Field, IconAction, QueryState } from "./featurePrimitives";
import { GuardrailShell } from "./guardrailsView";
import { ExternalProfileFields, externalProfileDefaults, externalProfileErrors, hasExternalProfileForm } from "./externalProfileFields";

const emptyPattern: GuardrailPattern = {
	pattern: "",
	entity_type: "REGEX_MATCH",
	flags: "",
	action: "block",
	redaction_strategy: "replace",
	redaction_mode: "runtime",
};
const piiPatterns: GuardrailPattern[] = [
	{ pattern: "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b", entity_type: "EMAIL", flags: "i" },
	{ pattern: "\\b(?:\\+?1[-.\\s]?)?(?:\\(?\\d{3}\\)?[-.\\s]?)\\d{3}[-.\\s]?\\d{4}\\b", entity_type: "PHONE_NUMBER" },
	{ pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", entity_type: "US_SSN" },
	{ pattern: "\\b(?:\\d[ -]?){13,19}\\b", entity_type: "CREDIT_CARD" },
	{ pattern: "\\b(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}\\b", entity_type: "IP_ADDRESS" },
].map((pattern) => ({ ...emptyPattern, ...pattern }));

type EditingProfile = { provider: string; profile?: GuardrailProfile };

/** 配置只展示宿主报告的真实 provider 能力，删除和启停均回读持久化状态。 */
export function ProfilesView() {
	const { t } = useTranslation("forkFeatures");
	const query = useGetForkGuardrailProvidersQuery();
	const [save, saveState] = useSaveForkGuardrailProfileMutation();
	const [remove, removeState] = useDeleteForkGuardrailProfileMutation();
	const [editing, setEditing] = useState<EditingProfile | null>(null);
	const [deleting, setDeleting] = useState<{ provider: string; profile: GuardrailProfile } | null>(null);
	const [error, setError] = useState<unknown>();
	const [search, setSearch] = useState("");
	const rows = (query.data ?? [])
		.flatMap((p) => p.configs.map((profile) => ({ provider: p.name, profile })))
		.filter((row) => `${row.provider} ${row.profile.name}`.toLowerCase().includes(search.toLowerCase()));
	const allowed: GuardrailCapability[] = (query.data ?? [])
		.filter(
			(provider) => ["regex", "secrets", "presidio", "prompt-guardrail"].includes(provider.name) || hasExternalProfileForm(provider.name),
		)
		.map((provider) => ({
			name: provider.name,
			local: ["regex", "secrets"].includes(provider.name),
			actions:
				provider.name === "prompt-guardrail" ? ["block"] : hasExternalProfileForm(provider.name) ? [] : ["detect_only", "block", "redact"],
		}));
	const mutate = async (body: Parameters<typeof save>[0]) => {
		await save(body).unwrap();
		setEditing(null);
		try {
			await query.refetch().unwrap();
		} catch {
			setError(new Error(t("common.readbackFailed")));
			return;
		}
		toast.success(t("common.savedVerified"));
	};
	return (
		<GuardrailShell active="providers">
			<FeatureHeader
				title={t("guardrails.providers")}
				busy={query.isFetching}
				refresh={() => {
					void query.refetch();
				}}
			>
				<Button
					disabled={!!query.error || !allowed.length || query.isLoading}
					onClick={() => setEditing({ provider: allowed[0].name })}
					data-testid="guardrail-create-profile"
				>
					<Plus className="size-4" />
					{t("guardrails.newProfile")}
				</Button>
			</FeatureHeader>
			<Input
				aria-label={t("common.search")}
				placeholder={t("common.search")}
				className="max-w-sm"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
			/>
			<ApiError error={error} />
			<QueryState loading={query.isLoading} error={query.error} empty={!rows.length}>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t("common.name")}</TableHead>
							<TableHead>{t("guardrails.providerType")}</TableHead>
							<TableHead>{t("common.enabled")}</TableHead>
							<TableHead>{t("common.actions")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map(({ provider, profile }) => (
							<TableRow key={`${provider}:${profile.id}`}>
								<TableCell className="max-w-72 break-words whitespace-normal">{profile.name}</TableCell>
								<TableCell>{t(`guardrails.${provider}`, { defaultValue: provider })}</TableCell>
								<TableCell>
									<Switch
										checked={profile.enabled}
										disabled={saveState.isLoading || (provider === "a10" && !profile.enabled)}
										aria-label={`${t("common.enabled")}: ${profile.name}`}
										onCheckedChange={(enabled) => {
											const { id, name, enabled: _enabled, ...config } = profile;
											setError(undefined);
											void mutate({ provider, id, name, enabled, config }).catch(setError);
										}}
										data-testid={`guardrail-profile-enabled-${profile.id}`}
									/>
									{provider === "a10" && (
										<IconAction label={t("guardrails.external.verificationRequired")}>
											<Info className="size-4" />
										</IconAction>
									)}
								</TableCell>
								<TableCell>
									<div className="flex">
										<IconAction
											label={t("common.edit")}
											onClick={() => setEditing({ provider, profile })}
											disabled={!allowed.some((p) => p.name === provider)}
										>
											<Pencil className="size-4" />
										</IconAction>
										<IconAction
											label={t("common.delete")}
											onClick={() => {
												setDeleting({ provider, profile });
												setError(undefined);
											}}
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
			{editing && (
				<ProfileEditor
					editing={editing}
					capabilities={allowed}
					busy={saveState.isLoading}
					onClose={() => setEditing(null)}
					onSave={async (body) => {
						await mutate(body);
						setEditing(null);
					}}
				/>
			)}
			<ConfirmAction
				open={!!deleting}
				title={t("common.delete")}
				description={t("common.deleteDescription", { name: deleting?.profile.name })}
				busy={removeState.isLoading}
				error={error}
				onClose={() => setDeleting(null)}
				onConfirm={() => {
					if (!deleting) return;
					setError(undefined);
					void (async () => {
						try {
							await remove({ provider: deleting.provider, id: deleting.profile.id }).unwrap();
							setDeleting(null);
							await query.refetch().unwrap();
							toast.success(t("common.savedVerified"));
						} catch (err) {
							setError(err);
						}
					})();
				}}
			/>
		</GuardrailShell>
	);
}

/** 为已有真实检测器初始化公开字段，不填充业务数据。 */
function defaultConfig(provider: string): GuardrailProfileConfig {
	switch (provider) {
		case "regex":
			return { patterns: [{ ...emptyPattern }] };
		case "secrets":
			return { ignored_secret_keywords: [], action: "block", redaction_strategy: "replace", redaction_mode: "runtime" };
		case "prompt-guardrail":
			return { judge_provider: "", judge_model: "", rule: "", prompt_template: "", timeout: 30, max_output_tokens: 200 };
		case "presidio":
			return {
				analyzer_url: "",
				api_key: "",
				language: "en",
				entities: [],
				score_threshold: 0.5,
				action: "detect_only",
				redaction_strategy: "replace",
				redaction_mode: "runtime",
				timeout: 30,
			};
		default:
			return externalProfileDefaults(provider);
	}
}

/** Presidio 地址不允许内嵌凭据、查询参数或片段，与服务端解析约束一致。 */
function validAnalyzerURL(value: string | undefined) {
	try {
		const url = new URL(value ?? "");
		return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
	} catch {
		return false;
	}
}

/** 原生检测器用结构化表单，外部凭据只接受环境变量引用且不回显明文。 */
function ProfileEditor({
	editing,
	capabilities,
	busy,
	onClose,
	onSave,
}: {
	editing: EditingProfile;
	capabilities: GuardrailCapability[];
	busy: boolean;
	onClose: () => void;
	onSave: (body: { provider: string; id?: number; name: string; enabled: boolean; config: GuardrailProfileConfig }) => Promise<void>;
}) {
	const { t } = useTranslation("forkFeatures");
	const initial = editing.profile
		? {
				provider: editing.provider,
				...(({ id, name, enabled, ...config }) => ({ id, name, enabled, config }))(editing.profile),
			}
		: { provider: editing.provider, name: "", enabled: editing.provider !== "a10", config: defaultConfig(editing.provider) };
	const [draft, setDraft] = useState(initial);
	const [error, setError] = useState<unknown>();
	const [externalDraftValid, setExternalDraftValid] = useState(true);
	const config = draft.config;
	const update = (next: Partial<GuardrailProfileConfig>) => setDraft((d) => ({ ...d, config: { ...d.config, ...next } }));
	const actions = capabilities.find((c) => c.name === draft.provider)?.actions ?? [];
	const numberError = (value: number | undefined, min: number, max: number) =>
		value !== undefined && Number.isInteger(value) && value >= min && value <= max ? undefined : t("common.invalidNumber", { min, max });
	const patternInvalid = config.patterns?.some((p) => !p.pattern.trim() || p.pattern.length > 8192 || !/^[ims]{0,3}$/.test(p.flags ?? ""));
	let valid = !!draft.name.trim() && capabilities.some((c) => c.name === draft.provider);
	if (hasExternalProfileForm(draft.provider))
		valid &&= Object.keys(externalProfileErrors(draft.provider, config)).length === 0 && externalDraftValid;
	if (draft.provider === "a10" && draft.enabled) valid = false;
	if (draft.provider === "regex") valid &&= !!config.patterns?.length && !patternInvalid;
	if (draft.provider === "prompt-guardrail")
		valid &&=
			!!config.judge_provider &&
			!!config.judge_model &&
			!!config.rule?.trim() &&
			(!config.prompt_template || (config.prompt_template.includes("{{rule}}") && !config.prompt_template.includes("{{content}}"))) &&
			!numberError(config.max_output_tokens, 1, 1024) &&
			!numberError(config.timeout, 1, 3600);
	if (draft.provider === "presidio")
		valid &&=
			validAnalyzerURL(config.analyzer_url) &&
			(!config.api_key || /^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key)) &&
			Number.isFinite(config.score_threshold) &&
			(config.score_threshold ?? -1) >= 0 &&
			(config.score_threshold ?? 2) <= 1;
	if (config.timeout !== undefined && !hasExternalProfileForm(draft.provider))
		valid &&= !numberError(config.timeout, draft.provider === "prompt-guardrail" ? 1 : 0, 3600);
	const patternUpdate = (index: number, next: Partial<GuardrailPattern>) =>
		update({ patterns: config.patterns?.map((p, i) => (i === index ? { ...p, ...next } : p)) });
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
			title={t(editing.profile ? "guardrails.editProfile" : "guardrails.newProfile")}
			dirty={JSON.stringify(draft) !== JSON.stringify(initial) || !externalDraftValid}
			busy={busy}
			error={error}
			valid={valid}
			onClose={onClose}
			onSave={() => void submit()}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label={t("common.name")} error={!draft.name.trim() ? t("common.required") : undefined}>
					<Input
						aria-label={t("common.name")}
						value={draft.name}
						onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
						maxLength={256}
						data-testid="guardrail-profile-name"
					/>
				</Field>
				<Field label={t("common.enabled")}>
					<Switch
						aria-label={t("common.enabled")}
						checked={draft.enabled}
						disabled={draft.provider === "a10" && !draft.enabled}
						onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
					/>
					{draft.provider === "a10" && (
						<IconAction label={t("guardrails.external.verificationRequired")}>
							<Info className="size-4" />
						</IconAction>
					)}
				</Field>
			</div>
			<Field label={t("guardrails.providerType")}>
				<Choice
					label={t("guardrails.providerType")}
					value={draft.provider}
					disabled={!!editing.profile}
					onChange={(provider) => {
						setExternalDraftValid(true);
						setDraft((d) => ({ ...d, provider, enabled: provider === "a10" ? false : d.enabled, config: defaultConfig(provider) }));
					}}
					options={capabilities.map((c) => ({ value: c.name, label: t(`guardrails.${c.name}`, { defaultValue: c.name }) }))}
				/>
			</Field>
			{hasExternalProfileForm(draft.provider) && (
				<ExternalProfileFields
					key={draft.provider}
					provider={draft.provider}
					config={config}
					onChange={update}
					onDraftValidity={setExternalDraftValid}
				/>
			)}
			{draft.provider === "regex" && (
				<section className="space-y-4">
					{(config.patterns ?? []).map((pattern, index) => (
						<div key={index} className="space-y-3 border-t pt-3">
							<div className="flex items-center justify-between">
								<span className="text-xs font-medium">
									{t("guardrails.pattern")} {index + 1}
								</span>
								<IconAction
									label={t("guardrails.removePattern")}
									onClick={() => update({ patterns: config.patterns?.filter((_, i) => i !== index) })}
								>
									<Trash2 className="size-4" />
								</IconAction>
							</div>
							<Field label={t("guardrails.pattern")} error={!pattern.pattern.trim() ? t("common.required") : undefined}>
								<Textarea
									aria-label={t("guardrails.pattern")}
									className="font-mono text-xs"
									value={pattern.pattern}
									onChange={(e) => patternUpdate(index, { pattern: e.target.value })}
									maxLength={8192}
								/>
							</Field>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label={t("guardrails.entity")}>
									<Input
										aria-label={t("guardrails.entity")}
										value={pattern.entity_type ?? ""}
										onChange={(e) => patternUpdate(index, { entity_type: e.target.value })}
										maxLength={64}
									/>
								</Field>
								<Field label={t("common.description")}>
									<Input
										aria-label={t("common.description")}
										value={pattern.description ?? ""}
										onChange={(e) => patternUpdate(index, { description: e.target.value })}
									/>
								</Field>
							</div>
							<Field label={t("guardrails.flags")}>
								<div className="flex gap-3">
									{["i", "m", "s"].map((flag) => (
										<label key={flag} className="flex items-center gap-2 text-xs">
											<Switch
												aria-label={flag}
												checked={(pattern.flags ?? "").includes(flag)}
												onCheckedChange={(checked) =>
													patternUpdate(index, {
														flags: checked ? `${pattern.flags ?? ""}${flag}` : (pattern.flags ?? "").replace(flag, ""),
													})
												}
											/>
											{flag}
										</label>
									))}
								</div>
							</Field>
							<ActionFields value={pattern} actions={actions} onChange={(next) => patternUpdate(index, next)} />
						</div>
					))}
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={(config.patterns?.length ?? 0) >= 128}
							onClick={() => update({ patterns: [...(config.patterns ?? []), { ...emptyPattern }] })}
						>
							<Plus className="size-4" />
							{t("guardrails.addPattern")}
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={(config.patterns?.length ?? 0) > 123}
							onClick={() =>
								update({ patterns: [...(config.patterns ?? []).filter((p) => p.pattern), ...piiPatterns.map((p) => ({ ...p }))] })
							}
						>
							<Plus className="size-4" />
							{t("guardrails.piiTemplate")}
						</Button>
					</div>
				</section>
			)}
			{draft.provider === "secrets" && (
				<>
					<Field label={t("guardrails.ignoredKeywords")}>
						<TagInput
							aria-label={t("guardrails.ignoredKeywords")}
							value={config.ignored_secret_keywords ?? []}
							onValueChange={(value) => update({ ignored_secret_keywords: value })}
						/>
					</Field>
					<ActionFields value={config} actions={actions} onChange={update} />
				</>
			)}
			{draft.provider === "prompt-guardrail" && (
				<>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label={t("guardrails.judgeProvider")} error={!config.judge_provider ? t("common.required") : undefined}>
							<ProviderSelector
								value={config.judge_provider ?? ""}
								onChange={(judge_provider: string) => update({ judge_provider, judge_model: "" })}
							/>
						</Field>
						<Field label={t("guardrails.judgeModel")} error={!config.judge_model ? t("common.required") : undefined}>
							<ModelSelector
								provider={config.judge_provider}
								value={config.judge_model ?? ""}
								onChange={(judge_model) => update({ judge_model })}
								allowCustomModel
							/>
						</Field>
					</div>
					<Field label={t("guardrails.policy")} error={!config.rule?.trim() ? t("common.required") : undefined}>
						<Textarea
							aria-label={t("guardrails.policy")}
							rows={4}
							value={config.rule ?? ""}
							onChange={(e) => update({ rule: e.target.value })}
						/>
					</Field>
					<Field
						label={t("guardrails.promptTemplate")}
						error={
							config.prompt_template && (!config.prompt_template.includes("{{rule}}") || config.prompt_template.includes("{{content}}"))
								? t("common.invalid")
								: undefined
						}
					>
						<Textarea
							aria-label={t("guardrails.promptTemplate")}
							rows={4}
							value={config.prompt_template ?? ""}
							onChange={(e) => update({ prompt_template: e.target.value })}
						/>
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						{(["timeout", "max_output_tokens"] as const).map((key) => (
							<Field
								key={key}
								label={t(key === "timeout" ? "guardrails.timeout" : "guardrails.maxTokens")}
								error={numberError(config[key], 1, key === "timeout" ? 3600 : 1024)}
							>
								<Input
									type="number"
									step={1}
									min={1}
									max={key === "timeout" ? 3600 : 1024}
									aria-label={t(key === "timeout" ? "guardrails.timeout" : "guardrails.maxTokens")}
									value={config[key] ?? ""}
									onChange={(e) => update({ [key]: e.target.valueAsNumber })}
								/>
							</Field>
						))}
					</div>
				</>
			)}
			{draft.provider === "presidio" && (
				<>
					<Field label={t("guardrails.baseUrl")} error={!validAnalyzerURL(config.analyzer_url) ? t("common.invalid") : undefined}>
						<Input
							aria-label={t("guardrails.baseUrl")}
							value={config.analyzer_url ?? ""}
							onChange={(e) => update({ analyzer_url: e.target.value })}
							autoComplete="off"
						/>
					</Field>
					<Field
						label={t("guardrails.apiKeyReference")}
						error={config.api_key && !/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key) ? t("common.invalid") : undefined}
					>
						<SecretVarInput
							aria-label={t("guardrails.apiKeyReference")}
							type="password"
							hideValueWhenEnv
							maskNonEnvValue
							maskVisiblePrefix={0}
							maskVisibleSuffix={0}
							value={
								/^env\.[A-Za-z_][A-Za-z0-9_]*$/.test(config.api_key ?? "")
									? { value: "", ref: config.api_key, type: "env" }
									: { value: config.api_key ?? "", ref: "" }
							}
							onChange={(next) => update({ api_key: next.type === "env" ? next.ref : next.value })}
							placeholder="env.PRESIDIO_API_KEY"
							autoComplete="off"
						/>
					</Field>
					<div className="grid gap-4 sm:grid-cols-2">
						<Field label={t("guardrails.language")}>
							<Input
								aria-label={t("guardrails.language")}
								value={config.language ?? ""}
								onChange={(e) => update({ language: e.target.value })}
							/>
						</Field>
						<Field
							label={t("guardrails.scoreThreshold")}
							error={
								!Number.isFinite(config.score_threshold) || (config.score_threshold ?? -1) < 0 || (config.score_threshold ?? 2) > 1
									? t("common.invalid")
									: undefined
							}
						>
							<Input
								aria-label={t("guardrails.scoreThreshold")}
								type="number"
								min={0}
								max={1}
								step={0.01}
								value={config.score_threshold ?? ""}
								onChange={(e) => update({ score_threshold: e.target.valueAsNumber })}
							/>
						</Field>
					</div>
					<Field label={t("guardrails.entities")}>
						<TagInput
							aria-label={t("guardrails.entities")}
							value={config.entities ?? []}
							onValueChange={(entities) => update({ entities })}
						/>
					</Field>
					<ActionFields value={config} actions={actions} onChange={update} />
				</>
			)}
			{draft.provider !== "prompt-guardrail" && !hasExternalProfileForm(draft.provider) && (
				<Field label={t("guardrails.timeout")} error={config.timeout === undefined ? undefined : numberError(config.timeout, 0, 3600)}>
					<Input
						aria-label={t("guardrails.timeout")}
						type="number"
						min={0}
						max={3600}
						step={1}
						value={config.timeout === undefined || Number.isNaN(config.timeout) ? "" : config.timeout}
						onChange={(event) => update({ timeout: event.target.value === "" ? undefined : event.target.valueAsNumber })}
					/>
				</Field>
			)}
		</EditorDialog>
	);
}

function ActionFields({
	value,
	actions,
	onChange,
}: {
	value: Partial<GuardrailPattern>;
	actions: GuardrailAction[];
	onChange: (value: Partial<GuardrailPattern>) => void;
}) {
	const { t } = useTranslation("forkFeatures");
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<Field label={t("guardrails.action")}>
				<Choice
					label={t("guardrails.action")}
					value={value.action ?? "block"}
					onChange={(v) => onChange({ action: v as GuardrailAction })}
					options={actions.map((v) => ({ value: v, label: t(v === "detect_only" ? "guardrails.detect" : `guardrails.${v}`) }))}
				/>
			</Field>
			{value.action === "redact" && (
				<>
					<Field label={t("guardrails.strategy")}>
						<Choice
							label={t("guardrails.strategy")}
							value={value.redaction_strategy ?? "replace"}
							onChange={(v) => onChange({ redaction_strategy: v })}
							options={["replace", "mask", "hash"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
						/>
					</Field>
					<Field label={t("guardrails.redactionMode")}>
						<Choice
							label={t("guardrails.redactionMode")}
							value={value.redaction_mode ?? "runtime"}
							onChange={(v) => onChange({ redaction_mode: v })}
							options={["runtime", "logs_only", "runtime_reversible"].map((v) => ({ value: v, label: t(`guardrails.${v}`) }))}
						/>
					</Field>
				</>
			)}
		</div>
	);
}