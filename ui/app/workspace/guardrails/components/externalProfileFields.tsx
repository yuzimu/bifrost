import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretVarInput } from "@/components/ui/secretVarInput";
import { Switch } from "@/components/ui/switch";
import { TagInput } from "@/components/ui/tagInput";
import { Textarea } from "@/components/ui/textarea";
import type { GuardrailProfileConfig } from "@/lib/types/forkFeatures";
import { Info, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Choice, Field, IconAction } from "./featurePrimitives";

type ConfigKey = keyof GuardrailProfileConfig;
type ProviderField = {
	key: ConfigKey;
	kind?: "secret" | "url" | "number" | "boolean" | "array" | "select";
	required?: boolean;
	options?: string[];
	min?: number;
	max?: number;
	origin?: boolean;
	visible?: (config: GuardrailProfileConfig) => boolean;
};
const envReference = /^env\.[A-Za-z_][A-Za-z0-9_]*$/;
const resource = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const apiKey: ProviderField = { key: "api_key", kind: "secret", required: true };
const baseURL: ProviderField = { key: "base_url", kind: "url" };
const azureAuth: ProviderField[] = [
	{ key: "endpoint", kind: "url", required: true, origin: true },
	{ key: "auth_type", kind: "select", options: ["api_key", "entra_id", "default_credential"] },
	{ ...apiKey, visible: (c) => (c.auth_type ?? "api_key") === "api_key" },
	{ key: "client_id", kind: "secret", required: true, visible: (c) => c.auth_type === "entra_id" },
	{ key: "client_secret", kind: "secret", required: true, visible: (c) => c.auth_type === "entra_id" },
	{ key: "tenant_id", required: true, visible: (c) => c.auth_type === "entra_id" },
	{ key: "scopes", kind: "array", visible: (c) => (c.auth_type ?? "api_key") !== "api_key" },
];
const redaction: ProviderField[] = [
	{ key: "action", kind: "select", options: ["detect_only", "block", "redact"] },
	{ key: "redaction_strategy", kind: "select", options: ["replace", "mask", "hash"], visible: (c) => c.action === "redact" },
	{ key: "redaction_mode", kind: "select", options: ["runtime", "logs_only", "runtime_reversible"], visible: (c) => c.action === "redact" },
];
const bedrockAuth = (c: GuardrailProfileConfig) =>
	c.auth_type ?? (c.bedrock_api_key ? "api_key" : c.access_key || c.secret_key ? "keys" : "iam_role");

// 字段名单直接对应十个真实 adapter 的严格 snake_case 配置，不代表服务端已注册名单。
const providerFields: Record<string, ProviderField[]> = {
	a10: [
		{ key: "base_url", kind: "url", required: true, origin: true },
		{ key: "client_id", kind: "secret", required: true },
	],
	"crowdstrike-aidr": [apiKey, baseURL, { key: "app_id" }, { key: "collector_instance_id" }],
	"repelloai-argus": [apiKey, baseURL, { key: "asset_id", required: true }],
	lakera: [apiKey, baseURL, { key: "project_id", required: true }, ...redaction],
	grayswan: [
		apiKey,
		baseURL,
		{ key: "policy_id", required: true },
		{ key: "policy_ids", kind: "array" },
		{ key: "violation_threshold", kind: "number", min: 0, max: 1 },
		{ key: "reasoning_mode", kind: "select", options: ["off", "hybrid", "thinking"] },
	],
	"patronus-ai": [apiKey, baseURL, { key: "capture", kind: "select", options: ["none", "fails-only", "all"] }],
	"azure-pii": [
		...azureAuth,
		{ key: "api_version" },
		{ key: "language" },
		{ key: "model_version" },
		{ key: "domain", kind: "select", options: ["none", "phi"] },
		{ key: "pii_categories", kind: "array" },
		{ key: "logging_opt_out", kind: "boolean" },
		{ key: "string_index_type", kind: "select", options: ["UnicodeCodePoint"] },
		...redaction,
	],
	azure: [
		...azureAuth,
		{ key: "analyze_enabled", kind: "boolean" },
		{ key: "analyze_severity_threshold", kind: "select", options: ["low", "medium", "high"] },
		{ key: "jailbreak_shield_enabled", kind: "boolean" },
		{ key: "indirect_attack_shield_enabled", kind: "boolean" },
		{ key: "copyright_enabled", kind: "boolean" },
		{ key: "text_blocklist_enabled", kind: "boolean" },
		{ key: "blocklist_names", kind: "array", required: true, visible: (c) => c.text_blocklist_enabled === true },
	],
	bedrock: [
		{ key: "guardrail_arn", required: true },
		{ key: "guardrail_version", required: true },
		{ key: "region" },
		{ key: "auth_type", kind: "select", options: ["keys", "api_key", "iam_role"] },
		{ key: "access_key", kind: "secret", required: true, visible: (c) => bedrockAuth(c) === "keys" },
		{ key: "secret_key", kind: "secret", required: true, visible: (c) => bedrockAuth(c) === "keys" },
		{ key: "session_token", kind: "secret", visible: (c) => bedrockAuth(c) === "keys" },
		{ key: "bedrock_api_key", kind: "secret", required: true, visible: (c) => bedrockAuth(c) === "api_key" },
		{ key: "role_arn", visible: (c) => bedrockAuth(c) !== "api_key" },
		{ key: "external_id", kind: "secret", visible: (c) => !!c.role_arn && bedrockAuth(c) !== "api_key" },
		{ key: "session_name", visible: (c) => !!c.role_arn && bedrockAuth(c) !== "api_key" },
	],
	"model-armor": [
		{ key: "project_id", required: true },
		{ key: "location", required: true },
		{ key: "template_id", required: true },
		{ key: "auth_type", kind: "select", options: ["default_credential", "service_account_json"] },
		{ key: "service_account_json", kind: "secret", required: true, visible: (c) => c.auth_type === "service_account_json" },
		baseURL,
	],
};

export function hasExternalProfileForm(provider: string) {
	return Object.hasOwn(providerFields, provider);
}

/** 只设协议默认选项与空必填值，资源 ID 和环境引用必须由用户提供。 */
export function externalProfileDefaults(provider: string): GuardrailProfileConfig {
	const common = { timeout: 30 };
	switch (provider) {
		case "azure":
			return { ...common, auth_type: "api_key", endpoint: "", api_key: "", analyze_enabled: true, analyze_severity_threshold: "medium" };
		case "azure-pii":
			return {
				...common,
				auth_type: "api_key",
				endpoint: "",
				api_key: "",
				api_version: "2026-05-01",
				language: "en",
				model_version: "latest",
				domain: "none",
				string_index_type: "UnicodeCodePoint",
				action: "detect_only",
			};
		case "bedrock":
			return { ...common, auth_type: "iam_role", guardrail_arn: "", guardrail_version: "", images_enabled: false };
		case "model-armor":
			return { ...common, auth_type: "default_credential", project_id: "", location: "", template_id: "", images_enabled: false };
		case "a10":
			return { ...common, base_url: "", client_id: "" };
		case "patronus-ai":
			return { ...common, api_key: "", capture: "none", evaluators: [{ evaluator: "", criteria: "", explain_strategy: "never" }] };
		case "grayswan":
			return { ...common, api_key: "", policy_id: "", violation_threshold: 0.5, reasoning_mode: "off", rules: {} };
		case "lakera":
			return { ...common, api_key: "", project_id: "", action: "block" };
		case "repelloai-argus":
			return { ...common, api_key: "", asset_id: "" };
		case "crowdstrike-aidr":
			return { ...common, api_key: "" };
		default:
			return {};
	}
}

/** URL 只做无网络的格式校验，环境展开、SSRF 与真实凭据可用性仍由宿主严格检查。 */
function validURL(value: string, origin: boolean) {
	if (envReference.test(value)) return true;
	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!!url.hostname &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(!origin || url.pathname === "/")
		);
	} catch {
		return false;
	}
}

/** 校验适用字段、互斥认证和 provider 特定约束，未知键不能被静默忽略。 */
export function externalProfileErrors(provider: string, config: GuardrailProfileConfig): Record<string, string> {
	const errors: Record<string, string> = {};
	const fields = providerFields[provider];
	if (!fields) return { provider: "unsupported" };
	const allowed = new Set<string>(fields.map((f) => f.key).concat(["timeout"]));
	if (provider === "grayswan") allowed.add("rules");
	if (provider === "patronus-ai") allowed.add("evaluators");
	if (provider === "bedrock" || provider === "model-armor") allowed.add("images_enabled");
	for (const key of Object.keys(config)) if (config[key as ConfigKey] !== undefined && !allowed.has(key)) errors[key] = "unknown";
	for (const field of fields) {
		const value = config[field.key];
		if (field.visible && !field.visible(config)) {
			if (value !== undefined && value !== "" && (!Array.isArray(value) || value.length)) errors[field.key] = "conflicting";
			continue;
		}
		if (field.required && (value === undefined || value === "" || (Array.isArray(value) && !value.length))) {
			errors[field.key] = "required";
			continue;
		}
		if (value === undefined || value === "") continue;
		if (field.kind === "secret" && (typeof value !== "string" || !envReference.test(value))) errors[field.key] = "envOnly";
		else if (field.kind === "url" && (typeof value !== "string" || !validURL(value, !!field.origin))) errors[field.key] = "invalidURL";
		else if (
			field.kind === "number" &&
			(typeof value !== "number" || !Number.isFinite(value) || value < (field.min ?? 0) || value > (field.max ?? Infinity))
		)
			errors[field.key] = "invalid";
		else if (field.kind === "select" && !field.options?.includes(String(value))) errors[field.key] = "invalid";
		else if (field.kind === "boolean" && typeof value !== "boolean") errors[field.key] = "invalid";
		else if (
			field.kind === "array" &&
			(!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim()) || new Set<unknown>(value).size !== value.length)
		)
			errors[field.key] = "invalid";
		else if (!field.kind && (typeof value !== "string" || !value.trim())) errors[field.key] = "invalid";
	}
	if (config.timeout !== undefined && (!Number.isInteger(config.timeout) || config.timeout < 1 || config.timeout > 300))
		errors.timeout = "invalid";
	if (
		provider === "azure" &&
		!(config.analyze_enabled ?? true) &&
		!config.jailbreak_shield_enabled &&
		!config.indirect_attack_shield_enabled &&
		!config.copyright_enabled &&
		!config.text_blocklist_enabled
	)
		errors.analyze_enabled = "policyRequired";
	if (provider === "azure-pii")
		for (const key of ["api_version", "language", "model_version"] as const)
			if (config[key] && !resource.test(config[key]!)) errors[key] = "invalid";
	if (provider === "azure" || provider === "azure-pii")
		for (const key of ["blocklist_names", "pii_categories"] as const)
			if (config[key]?.some((v) => !resource.test(v))) errors[key] = "invalid";
	if (provider === "model-armor")
		for (const key of ["project_id", "location", "template_id"] as const)
			if (config[key] && !envReference.test(config[key]!) && !resource.test(config[key]!)) errors[key] = "invalid";
	if (provider === "bedrock") {
		const arn = config.guardrail_arn ?? "";
		const parsed =
			/^arn:(aws|aws-us-gov|aws-cn):bedrock:([a-z]{2}(?:-[a-z0-9]+)+-\d+):\d{12}:guardrail\/([A-Za-z0-9][A-Za-z0-9_.-]{0,254})$/.exec(arn);
		if (!envReference.test(arn) && !parsed) errors.guardrail_arn = "invalid";
		if (!envReference.test(config.guardrail_version ?? "") && !/^(DRAFT|[1-9]\d{0,7})$/.test(config.guardrail_version ?? ""))
			errors.guardrail_version = "invalid";
		if (
			config.region &&
			!envReference.test(config.region) &&
			(!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(config.region) || (parsed && config.region !== parsed[2]))
		)
			errors.region = "invalid";
		if (
			config.role_arn &&
			!envReference.test(config.role_arn) &&
			!/^arn:(aws|aws-us-gov|aws-cn):iam::\d{12}:role\/.+$/.test(config.role_arn)
		)
			errors.role_arn = "invalid";
		if (config.session_name && !envReference.test(config.session_name) && !/^[A-Za-z0-9_+=,.@-]{2,64}$/.test(config.session_name))
			errors.session_name = "invalid";
	}
	if ((provider === "model-armor" || provider === "bedrock") && config.images_enabled !== false) errors.images_enabled = "textOnly";
	if (
		provider === "patronus-ai" &&
		(!config.evaluators?.length ||
			config.evaluators.some(
				(e) =>
					!e.evaluator.trim() ||
					(e.explain_strategy && !["never", "on-fail", "on-success", "always"].includes(e.explain_strategy)) ||
					Object.keys(e).some((key) => !["evaluator", "criteria", "explain_strategy"].includes(key)),
			))
	)
		errors.evaluators = "required";
	if (
		provider === "grayswan" &&
		config.rules &&
		Object.entries(config.rules).some(([key, value]) => !key.trim() || typeof value !== "string" || !value.trim())
	)
		errors.rules = "invalid";
	return errors;
}

/** 模式切换显式清除不适用认证字段，不保留会被服务端拒绝的混合凭据。 */
function authenticationChange(provider: string, value: string): Partial<GuardrailProfileConfig> {
	if (provider === "azure" || provider === "azure-pii")
		return {
			auth_type: value,
			api_key: undefined,
			client_id: undefined,
			client_secret: undefined,
			tenant_id: undefined,
			scopes: undefined,
		};
	if (provider === "bedrock")
		return {
			auth_type: value,
			access_key: undefined,
			secret_key: undefined,
			session_token: undefined,
			bedrock_api_key: undefined,
			role_arn: undefined,
			external_id: undefined,
			session_name: undefined,
		};
	return { auth_type: value, service_account_json: undefined };
}

/** 外部配置使用可见的严格字段控件，保存不触发验证调用，也不显示环境变量值。 */
export function ExternalProfileFields({
	provider,
	config,
	onChange,
	onDraftValidity,
}: {
	provider: string;
	config: GuardrailProfileConfig;
	onChange: (config: Partial<GuardrailProfileConfig>) => void;
	onDraftValidity: (valid: boolean) => void;
}) {
	const { t } = useTranslation("forkFeatures");
	const errors = externalProfileErrors(provider, config);
	const fields = [...(providerFields[provider] ?? []), { key: "timeout", kind: "number", min: 1, max: 300 } as ProviderField];
	const label = (key: string) => t(`guardrails.external.fields.${key}`, { defaultValue: key });
	const message = (key: string) => (errors[key] ? t(`guardrails.external.errors.${errors[key]}`) : undefined);
	return (
		<section className="space-y-4 border-t pt-3">
			<div className="flex items-center gap-2 text-sm">
				<span>{t(`guardrails.${provider}`, { defaultValue: provider })}</span>
				<IconAction label={t("guardrails.external.unverified")}>
					<Info className="size-4" />
				</IconAction>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				{fields
					.filter((f) => !f.visible || f.visible(config))
					.map((field) => {
						const value = config[field.key];
						const props = { "aria-label": label(field.key), "data-testid": `guardrail-external-${field.key}` };
						let control;
						if (field.kind === "secret") {
							const reference = typeof value === "string" && envReference.test(value) ? value : "";
							control = (
								<SecretVarInput
									{...props}
									type="password"
									hideValueWhenEnv
									maskNonEnvValue
									maskVisiblePrefix={0}
									maskVisibleSuffix={0}
									value={
										reference ? { value: "", ref: reference, type: "env" } : { value: typeof value === "string" ? value : "", ref: "" }
									}
									placeholder="env.NAME"
									onChange={(next) => onChange({ [field.key]: next.type === "env" ? next.ref : next.value })}
								/>
							);
						} else if (field.kind === "select") {
							const selected = String(
								value ?? (field.key === "auth_type" && provider === "bedrock" ? bedrockAuth(config) : (field.options?.[0] ?? "")),
							);
							control = (
								<Choice
									label={label(field.key)}
									value={selected}
									options={(field.options ?? []).map((option) => ({
										value: option,
										label: t(`guardrails.external.options.${option}`, { defaultValue: option }),
									}))}
									onChange={(next) => onChange(field.key === "auth_type" ? authenticationChange(provider, next) : { [field.key]: next })}
								/>
							);
						} else if (field.kind === "boolean") {
							control = (
								<Switch
									{...props}
									checked={typeof value === "boolean" ? value : field.key === "analyze_enabled"}
									onCheckedChange={(next) =>
										onChange(
											field.key === "text_blocklist_enabled" && !next
												? { text_blocklist_enabled: false, blocklist_names: undefined }
												: { [field.key]: next },
										)
									}
								/>
							);
						} else if (field.kind === "array") {
							control = (
								<TagInput
									{...props}
									value={Array.isArray(value) ? (value as string[]) : []}
									onValueChange={(next) => onChange({ [field.key]: next })}
								/>
							);
						} else {
							control = (
								<Input
									{...props}
									autoComplete="off"
									type={field.kind === "number" ? "number" : "text"}
									min={field.min}
									max={field.max}
									step={field.kind === "number" && field.key !== "timeout" ? 0.01 : 1}
									value={typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : ""}
									onChange={(event) =>
										onChange({
											[field.key]:
												field.kind === "number" ? (event.target.value === "" ? undefined : event.target.valueAsNumber) : event.target.value,
										})
									}
								/>
							);
						}
						return (
							<Field key={field.key} label={`${label(field.key)}${field.required ? " *" : ""}`} error={message(field.key)}>
								{control}
							</Field>
						);
					})}
			</div>
			{(provider === "bedrock" || provider === "model-armor") && (
				<Field label={label("images_enabled")} error={message("images_enabled")}>
					<div className="flex items-center gap-2 text-xs">
						{t("guardrails.external.textOnly")}
						{config.images_enabled !== false && (
							<Button type="button" variant="outline" size="sm" onClick={() => onChange({ images_enabled: false })}>
								{t("guardrails.external.useTextOnly")}
							</Button>
						)}
					</div>
				</Field>
			)}
			{provider === "a10" && <span className="text-muted-foreground text-xs">{t("guardrails.external.a10Decision")}</span>}
			{provider === "patronus-ai" && <EvaluatorFields config={config} onChange={onChange} error={message("evaluators")} />}
			{provider === "grayswan" && (
				<NaturalRules key={provider} initial={config.rules ?? {}} onChange={(rules) => onChange({ rules })} onValidity={onDraftValidity} />
			)}
			{Object.entries(errors)
				.filter(
					([key]) =>
						!fields.some((f) => f.key === key && (!f.visible || f.visible(config))) &&
						!["images_enabled", "evaluators", "rules"].includes(key),
				)
				.map(([key, code]) => (
					<p key={key} role="alert" className="text-destructive text-xs">
						{label(key)}: {t(`guardrails.external.errors.${code}`)}
					</p>
				))}
		</section>
	);
}

/** 每个 evaluator 有独立的名称、标准与解释策略，不透传任意 JSON 键。 */
function EvaluatorFields({
	config,
	onChange,
	error,
}: {
	config: GuardrailProfileConfig;
	onChange: (config: Partial<GuardrailProfileConfig>) => void;
	error?: string;
}) {
	const { t } = useTranslation("forkFeatures");
	const rows = config.evaluators ?? [];
	const update = (index: number, value: Partial<NonNullable<GuardrailProfileConfig["evaluators"]>[number]>) =>
		onChange({ evaluators: rows.map((row, i) => (i === index ? { ...row, ...value } : row)) });
	return (
		<Field label={t("guardrails.external.evaluators")} error={error}>
			<div className="space-y-4">
				{rows.map((row, index) => (
					<div key={index} className="space-y-3 border-t pt-3">
						<div className="flex items-center gap-2">
							<Input
								aria-label={t("guardrails.external.evaluator")}
								value={row.evaluator}
								onChange={(event) => update(index, { evaluator: event.target.value })}
							/>
							<IconAction label={t("common.delete")} onClick={() => onChange({ evaluators: rows.filter((_, i) => i !== index) })}>
								<Trash2 className="size-4" />
							</IconAction>
						</div>
						<Field label={t("guardrails.external.criteria")}>
							<Textarea
								aria-label={t("guardrails.external.criteria")}
								value={row.criteria ?? ""}
								onChange={(event) => update(index, { criteria: event.target.value })}
							/>
						</Field>
						<Field label={t("guardrails.external.explainStrategy")}>
							<Choice
								label={t("guardrails.external.explainStrategy")}
								value={row.explain_strategy || "never"}
								options={["never", "on-fail", "on-success", "always"].map((value) => ({
									value,
									label: t(`guardrails.external.options.${value}`),
								}))}
								onChange={(value) => update(index, { explain_strategy: value })}
							/>
						</Field>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					onClick={() => onChange({ evaluators: [...rows, { evaluator: "", explain_strategy: "never" }] })}
				>
					<Plus className="size-4" />
					{t("guardrails.external.addEvaluator")}
				</Button>
			</div>
		</Field>
	);
}

/** 自然语言策略的草稿行保留重复键错误，只有有效唯一键才生成配置 map。 */
function NaturalRules({
	initial,
	onChange,
	onValidity,
}: {
	initial: Record<string, string>;
	onChange: (rules: Record<string, string>) => void;
	onValidity: (valid: boolean) => void;
}) {
	const { t } = useTranslation("forkFeatures");
	const [rows, setRows] = useState(() => Object.entries(initial).map(([name, rule]) => ({ name, rule })));
	const valid = rows.every((row) => row.name.trim() && row.rule.trim()) && new Set(rows.map((row) => row.name)).size === rows.length;
	const commit = (next: typeof rows) => {
		setRows(next);
		const okay = next.every((row) => row.name.trim() && row.rule.trim()) && new Set(next.map((row) => row.name)).size === next.length;
		onValidity(okay);
		if (okay) onChange(Object.fromEntries(next.map((row) => [row.name, row.rule])));
	};
	return (
		<Field label={t("guardrails.external.naturalRules")} error={!valid ? t("guardrails.external.errors.uniqueRules") : undefined}>
			<div className="space-y-3">
				{rows.map((row, index) => (
					<div key={index} className="space-y-2 border-t pt-3">
						<div className="flex gap-2">
							<Input
								aria-label={t("common.name")}
								value={row.name}
								onChange={(event) => commit(rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r)))}
							/>
							<IconAction label={t("common.delete")} onClick={() => commit(rows.filter((_, i) => i !== index))}>
								<Trash2 className="size-4" />
							</IconAction>
						</div>
						<Textarea
							aria-label={t("guardrails.policy")}
							value={row.rule}
							onChange={(event) => commit(rows.map((r, i) => (i === index ? { ...r, rule: event.target.value } : r)))}
						/>
					</div>
				))}
				<Button type="button" variant="outline" onClick={() => commit([...rows, { name: "", rule: "" }])}>
					<Plus className="size-4" />
					{t("guardrails.external.addNaturalRule")}
				</Button>
			</div>
		</Field>
	);
}