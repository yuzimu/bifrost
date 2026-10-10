import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ModelSelector } from "@/components/ui/modelSelector";
import { ProviderSelector } from "@/components/ui/providerSelector";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TagInput } from "@/components/ui/tagInput";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	COMPLEXITY_TIER_VALUES,
	DecisionGuidanceDefaults,
	DecisionTier,
	KeywordListKey,
	MAX_DECISION_CRITERIA_ITEMS,
	MAX_DECISION_DEFINITION_CHARACTERS,
	MAX_DECISION_PREVIOUS_MESSAGE_COUNT,
	MAX_LLM_PROMPT_CHARACTERS,
	OPENROUTER_DECISION_MODELS,
	SELF_HOSTED_DECISION_MODELS,
	TIER_PHRASE_LIST_DEFINITIONS,
} from "@/lib/types/complexityRouter";
import { useGetModelsQuery } from "@/lib/store/apis/providersApi";
import type { ModelProvider } from "@/lib/types/config";
import { cn } from "@/lib/utils";
import { decisionProviderIconKey } from "@/lib/utils/decisionModelProviders";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronRight, Info, LoaderCircle, Pencil, RotateCcw, Scale, TriangleAlert, Waypoints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Controller,
	useWatch,
	type Control,
	type FieldError,
	type FieldErrors,
	type UseFormRegister,
	type UseFormSetValue,
} from "react-hook-form";
import {
	clefModelFromProvider,
	decisionTimeoutFieldValue,
	defaultDecisionModel,
	isDecisionProvider,
	selfHostedModelGroups,
	type AnalyzerFormValues,
	type DecisionProviderState,
} from "../formSchema";
import { FieldLabel, InfoTip, SectionHeading } from "./formPrimitives";
// The Complexity Router page's sections. Each binds to the page's single form.
// The three tier lists sit side by side, so each is a fixed-height scroll
// container rather than a fixed number of phrases: phrases wrap to different
// numbers of lines, and equal counts would leave the columns visibly uneven.
//
// This only evens out the lists themselves. The header above them varies too --
// a tier description that wraps to two lines pushes its list down by a line
// while its neighbours stay put -- so the cards stretch to the grid row and each
// is a flex column whose description grows to absorb the difference,
// bottom-aligning all three lists at any column width.
const PHRASE_LIST_HEIGHT = 300;
// Each decision-model tier card stacks two lists, so each gets under half the phrase
// list's height and a card stays about as tall as a phrase card.
const DECISION_LIST_HEIGHT = 140;
const DECISION_TIER_LABELS: Record<DecisionTier, string> = {
	SIMPLE: "routing.complexityUi.tierSimple",
	MEDIUM: "routing.complexityUi.tierMedium",
	COMPLEX: "routing.complexityUi.tierComplex",
};
function testIdPart(value: string) {
	return value.replace(/_/g, "-");
}
interface PhraseTierGridProps {
	control: Control<AnalyzerFormValues>;
	errors: FieldErrors<AnalyzerFormValues>["keywords"];
}
/** 保留各层参考短语编辑器，并在渲染时翻译标签与校验文案。 */
export function PhraseTierGrid({ control, errors }: PhraseTierGridProps) {
	const { t } = useTranslation("models");
	const tcpx = (key: string, opts?: Record<string, unknown>) => t(`routing.complexityUi.${key}`, opts);
	return (
		<div className="space-y-3">
			<Alert variant="info" data-testid="complexity-router-phrase-defaults-callout">
				<Info className="h-4 w-4" />
				<AlertDescription>{tcpx("phraseDefaultsCallout")}</AlertDescription>
			</Alert>

			{/* Root-level phrase issues such as cross-tier duplicates have no single
            field to attach to, so they render above the lists. */}
			{errors?.message && (
				<p className="text-destructive text-xs" data-testid="complexity-router-keywords-error">
					{errors.message}
				</p>
			)}

			{/* One column per tier, side by side: the three lists are read against
            each other, and equal-width columns keep a phrase's tier obvious
            from its position. */}
			<div className="grid items-stretch gap-3 md:grid-cols-3">
				{TIER_PHRASE_LIST_DEFINITIONS.map(({ key }) => {
					const fieldError = errors?.[key as KeywordListKey];
					const errorId = `keywords-${key}-error`;
					const labelKey = key === "simple_keywords" ? "tierSimple" : key === "medium_keywords" ? "tierMedium" : "tierComplex";
					const label = tcpx(labelKey);
					return (
						<div key={key} className="bg-card relative flex flex-col overflow-hidden rounded-sm border">
							<Controller
								control={control}
								name={`keywords.${key}` as const}
								rules={{
									validate: (value) => (value.length > 0 ? true : tcpx("phrasesEmpty", { tier: label })),
								}}
								render={({ field }) => (
									<div className="flex flex-1 flex-col space-y-2 p-4 pl-5">
										<div className="flex items-center justify-between">
											<span className="text-xs font-medium">{label}</span>
											<span className="text-muted-foreground font-mono text-[11px] tabular-nums">
												{tcpx("phraseCount", { count: field.value.length })}
											</span>
										</div>
										<p className="text-muted-foreground grow text-xs leading-relaxed">{tcpx(`${labelKey}Desc`)}</p>
										<TagInput
											data-testid={`complexity-router-keywords-${testIdPart(key)}-input`}
											value={field.value}
											onValueChange={field.onChange}
											listHeight={PHRASE_LIST_HEIGHT}
											submitOnComma
											placeholder={tcpx("phrasePlaceholder")}
											aria-invalid={fieldError ? true : undefined}
											aria-describedby={fieldError ? errorId : undefined}
											className={cn(fieldError && "border-destructive")}
										/>
										{fieldError && (
											<p id={errorId} className="text-destructive text-xs">
												{fieldError.message}
											</p>
										)}
									</div>
								)}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}
interface LLMPromptSectionProps {
	control: Control<AnalyzerFormValues>;
	error: FieldError | undefined;
	canUpdate: boolean;
	defaultPrompt: string;
	livePrompt: string;
	// Called on any operator edit, so a later status refresh never refills a
	// prompt the operator cleared on purpose.
	onEdit: () => void;
	onReset: () => void;
}
/** 翻译回退分类器编辑器的说明，不改动用户提示词。 */
export function LLMPromptSection({ control, error, canUpdate, defaultPrompt, livePrompt, onEdit, onReset }: LLMPromptSectionProps) {
	const { t } = useTranslation("models");
	const tcpx = (key: string) => t(`routing.complexityUi.${key}`);
	return (
		<div className="space-y-3">
			<SectionHeading
				title={tcpx("fallbackPromptTitle")}
				description={tcpx("fallbackPromptDescription")}
				aside={
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onReset}
						disabled={!canUpdate || !defaultPrompt || livePrompt === defaultPrompt}
						data-testid="complexity-router-llm-prompt-reset-button"
					>
						<RotateCcw className="h-3.5 w-3.5" />
						{tcpx("resetToDefault")}
					</Button>
				}
			/>
			<Controller
				control={control}
				name="llm.prompt"
				render={({ field }) => (
					<Textarea
						data-testid="complexity-router-llm-prompt-input"
						rows={8}
						maxLength={MAX_LLM_PROMPT_CHARACTERS}
						value={field.value}
						onChange={(event) => {
							onEdit();
							field.onChange(event);
						}}
						onBlur={field.onBlur}
						ref={field.ref}
						disabled={!canUpdate}
						aria-invalid={error ? true : undefined}
						className={cn("font-mono text-xs leading-relaxed", error && "border-destructive focus-visible:ring-destructive")}
					/>
				)}
			/>
			{error ? (
				<p className="text-destructive text-xs">{error.message}</p>
			) : (
				<p className="text-muted-foreground text-xs leading-relaxed">
					{tcpx("fallbackPromptHelp")}{" "}
					<span className="font-mono tabular-nums">
						{livePrompt.length}/{MAX_LLM_PROMPT_CHARACTERS}
					</span>
				</p>
			)}
		</div>
	);
}
interface SessionRoutingCardProps {
	control: Control<AnalyzerFormValues>;
	errors: FieldErrors<AnalyzerFormValues>["session"];
	canUpdate: boolean;
}
/** 两类分类器共用会话路由开关，说明随界面语言切换。 */
export function SessionRoutingCard({ control, errors, canUpdate }: SessionRoutingCardProps) {
	const { t } = useTranslation("models");
	return (
		<div className="bg-card flex items-center justify-between gap-6 rounded-sm border p-4">
			<div className="space-y-1">
				<FieldLabel htmlFor="complexity-router-session-enabled">{t("routing.complexityUi.sessionTitle")}</FieldLabel>
				<p className="text-muted-foreground max-w-3xl text-xs leading-relaxed">{t("routing.complexityUi.sessionHelp")}</p>
				{errors?.enabled && (
					<p id="complexity-router-session-enabled-error" className="text-destructive text-xs">
						{errors.enabled.message}
					</p>
				)}
			</div>
			<Controller
				control={control}
				name="session.enabled"
				render={({ field }) => (
					<Switch
						id="complexity-router-session-enabled"
						data-testid="complexity-router-session-enabled-switch"
						checked={field.value}
						onCheckedChange={field.onChange}
						disabled={!canUpdate}
						aria-invalid={errors?.enabled ? true : undefined}
						aria-describedby={errors?.enabled ? "complexity-router-session-enabled-error" : undefined}
					/>
				)}
			/>
		</div>
	);
}
const LAYA_MODELS: readonly string[] = SELF_HOSTED_DECISION_MODELS[0].models;
interface DecisionFieldsProps {
	control: Control<AnalyzerFormValues>;
	register: UseFormRegister<AnalyzerFormValues>;
	setValue: UseFormSetValue<AnalyzerFormValues>;
	errors: FieldErrors<AnalyzerFormValues>["decision"];
	canUpdate: boolean;
	// Every configured provider; the provider picker narrows it to decision providers.
	providers: ModelProvider[];
	// Ids of the selected provider's enabled keys, narrowing its model list to
	// what those keys may serve.
	providerKeyIds: string[];
}
// DecisionFields holds the decision model's settings: which model answers, and
// how much conversation it sees and for how long. They apply wherever the
// decision model runs, as the primary classifier or as the semantic fallback, so
// both places render this. The model control follows the provider: Typesafe and
// OpenRouter list Jev releases, a Cloudflare provider's URL fixes its Clef model,
// and a self-hosted provider offers the models it lists, or the known Laya and
// Nimble checkpoints when it lists none.
/** 按提供商展示决策模型字段，仅翻译说明而不改变模型与协议值。 */
export function DecisionFields({ control, register, setValue, errors, canUpdate, providers, providerKeyIds }: DecisionFieldsProps) {
	const { t } = useTranslation("models");
	const providerName = useWatch({ control, name: "decision.provider" });
	const model = useWatch({ control, name: "decision.model" });
	const provider = providers.find((candidate) => candidate.name === providerName);
	const servesJev = providerName === "typesafe" || providerName === "openrouter";
	const servesClef = clefModelFromProvider(provider) !== undefined;
	const selfHosted = provider !== undefined && !servesJev && !servesClef;
	const { data: listed } = useGetModelsQuery(
		{ provider: providerName, keys: providerKeyIds.length > 0 ? providerKeyIds : undefined, limit: 50 },
		{ skip: !selfHosted },
	);
	const listedModels = useMemo(() => (listed?.models ?? []).map((entry) => entry.name), [listed]);
	// A self-hosted provider that lists its models starts on the first one.
	useEffect(() => {
		if (selfHosted && !model && listedModels.length > 0) setValue("decision.model", listedModels[0], { shouldDirty: true });
	}, [selfHosted, model, listedModels, setValue]);
	return (
		<div className="grid gap-4 sm:grid-cols-2" data-testid="complexity-router-decision-fields">
			<div className="space-y-2">
				<FieldLabel htmlFor="decision-provider" tooltip={t("decisionUi.providerHelp")}>
					{t("decisionUi.provider")}
				</FieldLabel>
				<Controller
					control={control}
					name="decision.provider"
					render={({ field }) => (
						<ProviderSelector
							inputId="decision-provider"
							data-testid="complexity-router-decision-provider-select"
							filter={isDecisionProvider}
							resolveIconKey={decisionProviderIconKey}
							value={field.value || ""}
							onChange={(value: string) => {
								if (value === field.value) return;
								field.onChange(value);
								// A model name only means something on its own provider.
								const next = providers.find((candidate) => candidate.name === value);
								setValue("decision.model", defaultDecisionModel(next), { shouldDirty: true });
							}}
							disabled={!canUpdate}
						/>
					)}
				/>
				{!providers.some(isDecisionProvider) && (
					<p className="text-muted-foreground text-xs" data-testid="complexity-router-decision-no-provider">
						{t("decisionUi.noProvider")}{" "}
						<Link to="/workspace/providers" className="text-primary underline-offset-2 hover:underline">
							{t("decisionUi.addProvider")}
						</Link>
						.
					</p>
				)}
				{errors?.provider && <p className="text-destructive text-xs">{errors.provider.message}</p>}
			</div>
			<div className="space-y-2">
				<FieldLabel htmlFor="decision-model" tooltip={t("decisionUi.modelHelp")}>
					{t("decisionUi.model")}
				</FieldLabel>
				<Controller
					control={control}
					name="decision.model"
					render={({ field }) => {
						if (providerName === "openrouter") {
							// OpenRouter lists chat models under Typesafe's namespace too, and its
							// decisions endpoint rejects them, so only its Jev models are offered.
							return (
								<Select value={field.value || undefined} onValueChange={field.onChange} disabled={!canUpdate}>
									<SelectTrigger className="w-full" id="decision-model" data-testid="complexity-router-decision-model-select">
										<SelectValue placeholder={t("decisionUi.selectModel")} />
									</SelectTrigger>
									<SelectContent>
										{OPENROUTER_DECISION_MODELS.map((name) => (
											<SelectItem key={name} value={name}>
												{name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							);
						}
						if (servesJev || !provider) {
							return (
								<ModelSelector
									inputId="decision-model"
									data-testid="complexity-router-decision-model-select"
									provider={providerName || undefined}
									keys={providerKeyIds}
									value={field.value ?? ""}
									onChange={(next) => field.onChange(next)}
									allowCustomModel
									placeholder={providerName ? t("decisionUi.searchJev") : t("routing.complexityUi.selectProviderFirst")}
									disabled={!canUpdate || !providerName}
								/>
							);
						}
						if (servesClef) {
							// Cloudflare binds the model to the provider's URL, so it is shown, not
							// chosen: selecting the provider fills it in from that URL.
							return (
								<Input
									id="decision-model"
									data-testid="complexity-router-decision-model-input"
									value={field.value ?? ""}
									readOnly
									disabled
									className="font-mono"
								/>
							);
						}
						if (listedModels.length > 0) {
							// A listing is one page of a possibly longer catalog, so search and typed
							// names stay available instead of a fixed list that hides later models.
							return (
								<ModelSelector
									inputId="decision-model"
									data-testid="complexity-router-decision-model-select"
									provider={providerName || undefined}
									keys={providerKeyIds}
									value={field.value ?? ""}
									onChange={(next) => field.onChange(next)}
									allowCustomModel
									placeholder={t("decisionUi.searchModel")}
									disabled={!canUpdate}
								/>
							);
						}
						return (
							<Select value={field.value || undefined} onValueChange={field.onChange} disabled={!canUpdate}>
								<SelectTrigger className="w-full" id="decision-model" data-testid="complexity-router-decision-model-select">
									<SelectValue placeholder={t("decisionUi.selectModel")} />
								</SelectTrigger>
								<SelectContent>
									{selfHostedModelGroups(providerName).map((group) => (
										<SelectGroup key={group.label}>
											<SelectLabel>{group.label}</SelectLabel>
											{group.models.map((name) => (
												<SelectItem key={name} value={name}>
													{name}
												</SelectItem>
											))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
						);
					}}
				/>
				{servesClef && <p className="text-muted-foreground text-xs">{t("decisionUi.clefUrl")}</p>}
				{LAYA_MODELS.includes(model) && (
					<p className="text-muted-foreground text-xs">{t(model === "english" ? "decisionUi.layaEnglish" : "decisionUi.layaGuidance")}</p>
				)}
				{errors?.model && <p className="text-destructive text-xs">{errors.model.message}</p>}
			</div>
			<div className="space-y-2">
				<FieldLabel htmlFor="decision-previous-message-count" tooltip={t("decisionUi.previousMessagesHelp")}>
					{t("routing.complexityUi.maxMessagesSend")}
				</FieldLabel>
				<Input
					id="decision-previous-message-count"
					data-testid="complexity-router-decision-previous-message-count-input"
					type="number"
					min={0}
					max={MAX_DECISION_PREVIOUS_MESSAGE_COUNT}
					step={1}
					{...register("decision.previous_message_count", { valueAsNumber: true })}
					disabled={!canUpdate}
					aria-invalid={errors?.previous_message_count ? true : undefined}
					className={cn("font-mono", errors?.previous_message_count && "border-destructive focus-visible:ring-destructive")}
				/>
				{errors?.previous_message_count && <p className="text-destructive text-xs">{errors.previous_message_count.message}</p>}
			</div>
			<div className="space-y-2">
				<FieldLabel htmlFor="decision-timeout" tooltip={t("decisionUi.timeoutHelp")}>
					{t("routing.complexityUi.classificationTimeout")}
				</FieldLabel>
				<Controller
					control={control}
					name="decision.timeout"
					render={({ field }) => (
						<Input
							id="decision-timeout"
							data-testid="complexity-router-decision-timeout-input"
							type="number"
							min={1}
							step={10}
							disabled={!canUpdate}
							value={decisionTimeoutFieldValue(field.value)}
							onChange={(event) => {
								const raw = event.target.value;
								field.onChange(raw === "" ? "" : `${raw}ms`);
							}}
							aria-invalid={errors?.timeout ? true : undefined}
							className={cn("font-mono", errors?.timeout && "border-destructive focus-visible:ring-destructive")}
						/>
					)}
				/>
				{errors?.timeout && <p className="text-destructive text-xs">{errors.timeout.message}</p>}
			</div>
		</div>
	);
}
// The recommendation matches the semantic phrase callout, so both classifiers
// open the same way. The line under it says where the cards' content goes.
type DecisionListField = "signals" | "examples";
// Signals are traits to look for; examples are requests that have them. The
// tooltips say so because the two lists otherwise read as interchangeable.
const DECISION_LIST_FIELDS: Array<{
	field: DecisionListField;
	label: string;
	placeholder: string;
	tooltip: string;
}> = [
	{
		field: "signals",
		label: "decisionUi.signals",
		placeholder: "decisionUi.signalPlaceholder",
		tooltip: "decisionUi.signalsHelp",
	},
	{
		field: "examples",
		label: "decisionUi.examples",
		placeholder: "decisionUi.examplePlaceholder",
		tooltip: "decisionUi.examplesHelp",
	},
];
// sameList compares lists by value and order, matching the gateway's check
// for whether an override equals the shipped default.
function sameList(a: string[] | undefined, b: string[] | undefined) {
	if (!a || !b || a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}
interface DecisionDefinitionFieldProps {
	tier: DecisionTier;
	control: Control<AnalyzerFormValues>;
	error: string | undefined;
	canUpdate: boolean;
	edited: boolean;
	onReset: () => void;
}
// DecisionDefinitionField shows a tier's definition as plain text, like the
// semantic cards' tier descriptions, and turns into a textarea only while it
// is being edited. An invalid definition stays open so its error is visible.
/** 翻译层级编辑控件，定义正文仍保留服务器与用户原始数据。 */
function DecisionDefinitionField({ tier, control, error, canUpdate, edited, onReset }: DecisionDefinitionFieldProps) {
	const { t } = useTranslation("models");
	const tierLabel = t(DECISION_TIER_LABELS[tier]);
	const [editing, setEditing] = useState(false);
	const open = editing || Boolean(error);
	const id = `decision-${tier.toLowerCase()}-definition`;
	return (
		<Controller
			control={control}
			name={`decision.criteria.${tier}.definition` as const}
			render={({ field }) => (
				<div className="flex flex-1 flex-col space-y-1.5">
					<div className="flex h-6 items-center justify-between">
						<label htmlFor={id} className="text-xs font-medium">
							{tierLabel}
						</label>
						<div className="flex items-center gap-1">
							{canUpdate && !open && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-6"
											aria-label={t("decisionUi.editDefinition", { tier: tierLabel })}
											onClick={() => setEditing(true)}
											data-testid={`complexity-router-decision-${tier.toLowerCase()}-definition-edit-button`}
										>
											<Pencil className="size-3" />
										</Button>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs leading-relaxed">
										{t("decisionUi.definitionHelp", { tier: tierLabel })}
									</TooltipContent>
								</Tooltip>
							)}
							{edited && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-6"
											aria-label={t("decisionUi.resetDefinitionAria", { tier: tierLabel })}
											onClick={onReset}
											disabled={!canUpdate}
											data-testid={`complexity-router-decision-${tier.toLowerCase()}-definition-reset-button`}
										>
											<RotateCcw className="size-3" />
										</Button>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs leading-relaxed">{t("decisionUi.resetDefinition")}</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>
					{open ? (
						<Textarea
							id={id}
							data-testid={`complexity-router-decision-${tier.toLowerCase()}-definition-input`}
							rows={4}
							maxLength={MAX_DECISION_DEFINITION_CHARACTERS}
							autoFocus={editing}
							{...field}
							onBlur={() => {
								field.onBlur();
								setEditing(false);
							}}
							disabled={!canUpdate}
							aria-invalid={error ? true : undefined}
							className={cn("resize-none text-xs leading-relaxed", error && "border-destructive focus-visible:ring-destructive")}
						/>
					) : (
						// Grows like the phrase grid's description, so a definition that
						// wraps to an extra line does not push this card's lists below its
						// neighbours'.
						<p
							className={cn("text-muted-foreground grow text-xs leading-relaxed", canUpdate && "cursor-text")}
							onClick={() => canUpdate && setEditing(true)}
							data-testid={`complexity-router-decision-${tier.toLowerCase()}-definition-text`}
						>
							{field.value}
						</p>
					)}
					{error && <p className="text-destructive text-xs">{error}</p>}
				</div>
			)}
		/>
	);
}
interface DecisionGuidanceSectionProps {
	control: Control<AnalyzerFormValues>;
	setValue: UseFormSetValue<AnalyzerFormValues>;
	errors: FieldErrors<AnalyzerFormValues>["decision"];
	canUpdate: boolean;
	// Undefined until the status endpoint answers, or when the gateway predates
	// decision_defaults; the editors stay hidden rather than showing empty lists.
	defaults: DecisionGuidanceDefaults | undefined;
	defaultsLoading: boolean;
	// Primary sits directly under the step header, which already titles it;
	// the fallback shares the page with other sections, so it keeps a heading.
	variant: "primary" | "fallback";
}
// DecisionGuidanceSection edits the half of Decision's request an operator may tune:
// each tier's definition, signals, and examples. The question, decision and
// context rules, and answer contract stay fixed server-side. It mirrors the phrase grid
// and the llm prompt editor so the page keeps one visual language.
/** 编辑决策层级指引并保留服务端固定问答协议与默认正文。 */
export function DecisionGuidanceSection({
	control,
	setValue,
	errors,
	canUpdate,
	defaults,
	defaultsLoading,
	variant,
}: DecisionGuidanceSectionProps) {
	const { t } = useTranslation("models");
	const criteria = useWatch({ control, name: "decision.criteria" });
	const [fallbackOpen, setFallbackOpen] = useState(false);
	const isDefaultDefinition = (tier: DecisionTier) => criteria?.[tier]?.definition === defaults?.criteria[tier].definition;
	const isDefaultList = (tier: DecisionTier, field: DecisionListField) =>
		!!defaults && sameList(criteria?.[tier]?.[field], defaults.criteria[tier][field]);
	const isAllDefault = COMPLEXITY_TIER_VALUES.every(
		(tier) => isDefaultDefinition(tier) && DECISION_LIST_FIELDS.every(({ field }) => isDefaultList(tier, field)),
	);
	const resetList = (tier: DecisionTier, field: DecisionListField) => {
		if (!defaults) return;
		setValue(`decision.criteria.${tier}.${field}`, [...defaults.criteria[tier][field]], { shouldDirty: true, shouldValidate: true });
	};
	const resetDefinition = (tier: DecisionTier) => {
		if (!defaults) return;
		setValue(`decision.criteria.${tier}.definition`, defaults.criteria[tier].definition, { shouldDirty: true, shouldValidate: true });
	};
	const resetAll = () => {
		for (const tier of COMPLEXITY_TIER_VALUES) {
			resetDefinition(tier);
			for (const { field } of DECISION_LIST_FIELDS) resetList(tier, field);
		}
	};
	// Empty editors would read as "the decision model receives nothing" and invite saving that. Until
	// the shipped guidance is known, say so instead; saving meanwhile keeps
	// whatever is stored, because unseeded guidance is omitted from the payload.
	// Shared by both placements: the recommendation, what the decision model receives, and the
	// tier cards (or why they cannot be shown yet). The tier cards sit where the semantic phrase grid
	// does, so both classifiers read the same way; each holds its tier's only
	// definition.
	const body = (
		<>
			<Alert variant="info" data-testid="complexity-router-decision-guidance-defaults-callout">
				<Info className="h-4 w-4" />
				<AlertDescription>{t("decisionUi.guidanceNote")}</AlertDescription>
			</Alert>
			<p className="text-muted-foreground text-xs leading-relaxed">{t("decisionUi.guidanceUsage")}</p>
			{defaults ? (
				<div className="grid items-stretch gap-3 md:grid-cols-3">
					{COMPLEXITY_TIER_VALUES.map((tier) => (
						<div
							key={tier}
							className="bg-card flex flex-col rounded-sm border"
							data-testid={`complexity-router-decision-tier-${tier.toLowerCase()}`}
						>
							<div className="flex flex-1 flex-col space-y-3 p-4 pl-5">
								<DecisionDefinitionField
									tier={tier}
									control={control}
									error={errors?.criteria?.[tier]?.definition?.message}
									canUpdate={canUpdate}
									edited={!isDefaultDefinition(tier)}
									onReset={() => resetDefinition(tier)}
								/>
								{DECISION_LIST_FIELDS.map(({ field: listField, label, placeholder, tooltip }) => {
									const fieldError = errors?.criteria?.[tier]?.[listField];
									const errorId = `decision-${tier.toLowerCase()}-${listField}-error`;
									const count = criteria?.[tier]?.[listField]?.length ?? 0;
									const atLimit = count >= MAX_DECISION_CRITERIA_ITEMS;
									const edited = !isDefaultList(tier, listField);
									return (
										<Controller
											key={listField}
											control={control}
											name={`decision.criteria.${tier}.${listField}` as const}
											render={({ field }) => (
												<div className="space-y-1.5">
													{/* Fixed height so a row with a reset icon lines up with one without. */}
													<div className="flex h-6 items-center justify-between">
														<div className="flex items-center gap-1.5">
															<span className="text-muted-foreground text-xs">{t(label)}</span>
															<InfoTip label={t("decisionUi.about", { label: t(label) })}>{t(tooltip)}</InfoTip>
														</div>
														<div className="flex items-center gap-1">
															<span
																className={cn("font-mono text-[11px] tabular-nums", atLimit ? "text-amber-600" : "text-muted-foreground")}
															>
																{count} / {MAX_DECISION_CRITERIA_ITEMS}
															</span>
															{/* Doubles as the edited marker: present only where this list differs from the default. */}
															{edited && (
																<Button
																	type="button"
																	variant="ghost"
																	size="icon"
																	className="size-6"
																	aria-label={t("decisionUi.resetList", { tier: t(DECISION_TIER_LABELS[tier]), label: t(label) })}
																	onClick={() => resetList(tier, listField)}
																	disabled={!canUpdate}
																	data-testid={`complexity-router-decision-${tier.toLowerCase()}-${listField}-reset-button`}
																>
																	<RotateCcw className="size-3" />
																</Button>
															)}
														</div>
													</div>
													<TagInput
														data-testid={`complexity-router-decision-${tier.toLowerCase()}-${listField}-input`}
														value={field.value}
														onValueChange={field.onChange}
														listHeight={DECISION_LIST_HEIGHT}
														submitOnComma
														placeholder={atLimit ? t("decisionUi.limitReached", { count: MAX_DECISION_CRITERIA_ITEMS }) : t(placeholder)}
														readOnly={!canUpdate}
														disabled={!canUpdate || atLimit}
														aria-label={t("decisionUi.tierList", { tier: t(DECISION_TIER_LABELS[tier]), label: t(label) })}
														aria-invalid={fieldError ? true : undefined}
														aria-describedby={fieldError ? errorId : undefined}
														className={cn(fieldError && "border-destructive")}
													/>
													{fieldError && (
														<p id={errorId} className="text-destructive text-xs">
															{fieldError.message ?? fieldError.root?.message}
														</p>
													)}
												</div>
											)}
										/>
									);
								})}
							</div>
						</div>
					))}
				</div>
			) : (
				<div
					className="bg-card text-muted-foreground flex items-center gap-2 rounded-sm border p-4 text-xs"
					data-testid="complexity-router-decision-guidance-unavailable"
				>
					{defaultsLoading ? (
						<>
							<LoaderCircle className="size-3.5 animate-spin" />
							{t("decisionUi.loadingGuidance")}
						</>
					) : (
						<>
							<TriangleAlert className="size-3.5" />
							{t("decisionUi.guidanceUnavailable")}
						</>
					)}
				</div>
			)}
		</>
	);
	// The primary guidance is the step's main content and restores from the
	// page footer, as the semantic phrases do.
	if (variant === "primary") {
		return (
			<div className="space-y-3" data-testid="complexity-router-decision-guidance-primary">
				{body}
			</div>
		);
	}
	// The fallback shares the page with the semantic phrase grid, so it folds
	// away until opened; an invalid field forces it open so its error is never
	// hidden. The footer's Restore defaults resets the phrases, so the fallback
	// keeps its own Reset all.
	const open = fallbackOpen || Boolean(errors?.criteria);
	return (
		<Collapsible
			open={open}
			onOpenChange={setFallbackOpen}
			className="bg-card rounded-sm border"
			data-testid="complexity-router-decision-guidance-fallback"
		>
			<div className="flex items-center justify-between gap-2 px-4 py-3">
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex min-w-0 items-start gap-2 text-left"
						data-testid="complexity-router-decision-guidance-fallback-toggle"
					>
						<ChevronRight className={cn("text-muted-foreground mt-0.5 size-4 shrink-0 transition-transform", open && "rotate-90")} />
						<span className="space-y-1">
							<span className="block text-sm font-semibold">{t("decisionUi.fallbackGuidance")}</span>
							<span className="text-muted-foreground block text-xs">{t("decisionUi.fallbackGuidanceHelp")}</span>
						</span>
					</button>
				</CollapsibleTrigger>
				{defaults && !isAllDefault && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={resetAll}
						disabled={!canUpdate}
						data-testid="complexity-router-decision-guidance-reset-button"
					>
						<RotateCcw className="h-3.5 w-3.5" />
						{t("decisionUi.resetAll")}
					</Button>
				)}
			</div>
			<CollapsibleContent className="space-y-3 border-t p-4">{body}</CollapsibleContent>
		</Collapsible>
	);
}
const DECISION_PROVIDER_PROBLEMS: Record<
	Exclude<DecisionProviderState, "configured">,
	{
		message: string;
		action: string;
	}
> = {
	missing: { message: "decisionUi.providerMissing", action: "decisionUi.setupProvider" },
	failing: { message: "decisionUi.providerFailing", action: "decisionUi.reviewProvider" },
	"no-enabled-key": { message: "decisionUi.providerNoKey", action: "decisionUi.reviewKeys" },
};
// DecisionProviderAlert explains why the decision model cannot run, and links
// straight to its provider's page. That page opens a blank setup form when the
// provider does not exist yet, so one click lands on the fix either way.
/** 根据提供商状态显示本地化提示，并保留原有修复入口。 */
export function DecisionProviderAlert({ state, provider }: { state: DecisionProviderState; provider: string }) {
	const { t } = useTranslation("models");
	if (state === "configured" || !provider) return null;
	const problem = DECISION_PROVIDER_PROBLEMS[state];
	return (
		<Alert variant="warning" data-testid="complexity-router-decision-provider-alert">
			<TriangleAlert className="h-4 w-4" />
			<AlertDescription className="gap-2">
				<span>{t(problem.message, { provider })}</span>
				<Button asChild variant="outline" size="sm" data-testid="complexity-router-decision-provider-link">
					<Link to="/workspace/providers" search={{ provider }}>
						{t(problem.action, { provider })}
						<ArrowRight className="size-3.5" />
					</Link>
				</Button>
			</AlertDescription>
		</Alert>
	);
}
type Classifier = AnalyzerFormValues["classifier"];
const CLASSIFIER_OPTIONS: {
	value: Classifier;
	title: string;
	description: string;
}[] = [
	{
		value: "decision",
		title: "routing.complexityUi.decisionClassifier",
		description: "decisionUi.decisionDescription",
	},
	{
		value: "semantic",
		title: "routing.complexityUi.semanticClassifier",
		description: "decisionUi.semanticDescription",
	},
];
// ClassifierChoice is the one decision everything else depends on, so each
// option is an explained card rather than an entry in a dropdown. Anything a
// choice still needs is reported once, below the cards, after it is picked.
/** 显示分类器选择文案，保留 decision 与 semantic 协议值。 */
export function ClassifierChoice({ value, onChange }: { value: Classifier | undefined; onChange: (value: Classifier) => void }) {
	const { t } = useTranslation("models");
	return (
		<div role="radiogroup" aria-label={t("routing.complexityUi.classifierStep")} className="grid gap-3 sm:grid-cols-2">
			{CLASSIFIER_OPTIONS.map((option) => {
				const selected = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(option.value)}
						data-testid={`complexity-router-classifier-option-${option.value}`}
						className={cn(
							"hover:bg-accent/50 flex h-full flex-col gap-2 rounded-md border p-4 text-left transition-colors",
							selected && "border-primary bg-primary/5",
						)}
					>
						<div className="flex w-full items-center gap-2">
							{option.value === "decision" ? (
								<Scale className="text-muted-foreground size-4" />
							) : (
								<Waypoints className="text-muted-foreground size-4" />
							)}
							<span className="text-sm font-medium">{t(option.title)}</span>
							{selected && <Check className="ml-auto size-4 text-green-600" />}
						</div>
						<p className="text-muted-foreground text-xs leading-relaxed">{t(option.description)}</p>
					</button>
				);
			})}
		</div>
	);
}
interface StepRailProps {
	steps: {
		key: string;
		title: string;
		enabled: boolean;
	}[];
	currentIndex: number;
	onSelect: (index: number) => void;
}
// StepRail is the page's step nav. It takes the row style of the Edge inventory
// nav, and is narrower still: two short labels need little width, and every
// pixel it gives back goes to the phrase lists.
/** 显示分类配置步骤，沿用原有可进入条件与当前步骤。 */
export function StepRail({ steps, currentIndex, onSelect }: StepRailProps) {
	const { t } = useTranslation("models");
	return (
		<nav className="flex w-full shrink-0 gap-1 overflow-x-auto md:block md:w-44" aria-label={t("decisionUi.stepsAria")}>
			{steps.map((step, index) => {
				const current = index === currentIndex;
				return (
					<button
						key={step.key}
						type="button"
						onClick={() => !current && onSelect(index)}
						disabled={!step.enabled}
						aria-current={current ? "step" : undefined}
						data-testid={`complexity-router-step-${step.key}`}
						className={cn(
							"mb-1 flex h-8 w-auto shrink-0 items-center gap-2 rounded-sm border px-3 text-sm md:w-full md:min-w-0",
							current
								? "bg-secondary font-medium"
								: "text-muted-foreground hover:bg-secondary border-transparent hover:border enabled:cursor-pointer",
							!step.enabled && "cursor-not-allowed opacity-50 hover:border-transparent hover:bg-transparent",
						)}
					>
						<span
							className={cn(
								"flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
								current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
							)}
						>
							{index + 1}
						</span>
						{step.title}
					</button>
				);
			})}
		</nav>
	);
}