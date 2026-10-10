import { getExternalBaseUrl } from "@/app/workspace/mcp-registry/views/mcpUsageGuide/utils";
import { SectionHeader } from "@/app/workspace/mcp-registry/views/sectionHeader";
import { VirtualKeySelector } from "@/components/entitySelectors/virtualKeySelector";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HeadersTable } from "@/components/ui/headersTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretVarInput } from "@/components/ui/secretVarInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DottedSeparator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { VirtualKeyListItem } from "@/components/virtualKeyListItem";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage, useGetCoreConfigQuery, useGetVirtualKeysQuery } from "@/lib/store";
import { useCreateAgentMutation, useInspectAgentCardMutation, useUpdateAgentMutation } from "@/lib/store/apis/agentsApi";
import type {
	AgentAuthType,
	AgentOAuthConfig,
	AgentRegistrationView,
	AgentSecurityScheme,
	AgentTLSConfig,
	AgentUpstreamAuth,
	InspectAgentCardResponse,
} from "@/lib/types/agents";
import type { SecretVar } from "@/lib/types/schemas";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AgentEndpoints } from "./agentEndpoints";
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const emptySecret = (): SecretVar => ({ value: "", ref: "" });
const emptyAuth = (): AgentUpstreamAuth => ({ type: "none", headers: {} });
/** 翻译已知能力名称，保留未知协议字段。 */
function capabilityLabel(name: string, t: TFunction<"agents">) {
	const labels: Record<string, string> = {
		streaming: "capabilityStreaming",
		pushNotifications: "capabilityPushNotifications",
		stateTransitionHistory: "capabilityStateHistory",
		extendedAgentCard: "capabilityExtendedCard",
	};
	return labels[name] ? String(t(labels[name])) : name;
}
/** 按原有名称约束返回本地化的表单错误。 */
function validateAgentName(name: string, t: TFunction<"agents">): string | null {
	if (name.length < 1 || name.length > 255) return t("nameLength");
	if (!AGENT_NAME_PATTERN.test(name)) return t("nameFormat");
	return null;
}
function normalizeAuth(auth: AgentUpstreamAuth): AgentUpstreamAuth | undefined {
	const tls = hasTLS(auth.tls) ? auth.tls : undefined;
	if (auth.type === "none" && !tls) return undefined;
	return {
		type: auth.type,
		headers: Object.keys(auth.headers ?? {}).length ? auth.headers : undefined,
		oauth: auth.type === "oauth" ? auth.oauth : undefined,
		security_schemes: auth.security_schemes?.length ? auth.security_schemes : undefined,
		advanced: auth.advanced || undefined,
		tls,
	};
}
function hasTLS(tls?: AgentTLSConfig): boolean {
	return !!(
		tls?.insecure_skip_verify ||
		tls?.ca_cert_pem?.value ||
		tls?.ca_cert_pem?.ref ||
		tls?.client_cert_pem?.value ||
		tls?.client_cert_pem?.ref ||
		tls?.client_key_pem?.value ||
		tls?.client_key_pem?.ref
	);
}
/** 将 Agent 安全方案映射到实际请求头，缺失名称不生成凭据。 */
function headerName(scheme: AgentSecurityScheme): string | null {
	if (scheme.type === "apiKey" && scheme.in === "header") return scheme.header ?? null;
	if (scheme.type === "http" && ["bearer", "basic"].includes(scheme.scheme?.toLowerCase() ?? "")) return "Authorization";
	return null;
}
function authForRequirement(result: InspectAgentCardResponse, index: number): AgentUpstreamAuth | null {
	const names = result.security_requirements[index] ?? [];
	if (names.length === 0) return emptyAuth();
	const schemes = names.map((name) => result.security_schemes.find((scheme) => scheme.name === name));
	if (schemes.some((scheme) => !scheme)) return null;
	const headers = schemes.flatMap((scheme) => {
		const header = scheme ? headerName(scheme) : null;
		return header ? [header] : [];
	});
	const oauthSchemes = schemes.filter((scheme) => scheme?.type === "oauth2" || scheme?.type === "openIdConnect");
	const hasMutualTLS = schemes.some((scheme) => scheme?.type === "mutualTLS");
	if (
		headers.length + oauthSchemes.length + Number(hasMutualTLS) !== schemes.length ||
		oauthSchemes.length > 1 ||
		new Set(headers).size !== headers.length
	) {
		return null;
	}
	if (oauthSchemes.length && headers.length) return null;
	const oauthScheme = oauthSchemes[0];
	return {
		...emptyAuth(),
		type: oauthScheme ? "oauth" : headers.length ? "headers" : "none",
		headers: Object.fromEntries(headers.map((header) => [header, emptySecret()])),
		oauth: oauthScheme
			? {
					token_url: oauthScheme.token_url,
					client_id: emptySecret(),
					client_secret: emptySecret(),
					scopes: oauthScheme.scopes ?? [],
				}
			: undefined,
		security_schemes: names,
		tls: hasMutualTLS ? {} : undefined,
	};
}
/** 解释不支持的安全要求，不改变认证方案判定。 */
function requirementGap(result: InspectAgentCardResponse, index: number, t: TFunction<"agents">): string | null {
	const names = result.security_requirements[index] ?? [];
	const schemes = names.map((name) => result.security_schemes.find((scheme) => scheme.name === name));
	if (schemes.some((scheme) => !scheme)) return t("missingSecurityScheme");
	const oauthCount = schemes.filter((scheme) => scheme?.type === "oauth2" || scheme?.type === "openIdConnect").length;
	const headerCount = schemes.filter((scheme) => scheme && headerName(scheme)).length;
	if (oauthCount > 1) return t("oneOAuthClient");
	if (oauthCount && headerCount) return t("oauthHeadersConflict");
	const headers = schemes.flatMap((scheme) => {
		const header = scheme ? headerName(scheme) : null;
		return header ? [header] : [];
	});
	if (new Set(headers).size !== headers.length) return t("duplicateHeaderCredential");
	return t("unsupportedCredential");
}
function TLSFields({ value, onChange }: { value: AgentTLSConfig; onChange: (next: AgentTLSConfig) => void }) {
	const { t } = useTranslation("agents");
	return (
		<>
			<div className="flex items-center justify-between gap-4">
				<div className="space-y-0.5">
					<Label>{t("skipTls")}</Label>
					<p className="text-muted-foreground text-sm">{t("skipTlsDescription")}</p>
				</div>
				<Switch
					aria-label={t("skipTls")}
					checked={value.insecure_skip_verify ?? false}
					onCheckedChange={(insecure_skip_verify) => onChange({ ...value, insecure_skip_verify })}
				/>
			</div>
			<div className="space-y-1">
				<Label>{t("caCertificate")}</Label>
				<p className="text-muted-foreground text-sm">{t("caCertificateDescription")}</p>
				<SecretVarInput
					variant="textarea"
					rows={4}
					placeholder="-----BEGIN CERTIFICATE-----"
					value={value.ca_cert_pem}
					onChange={(ca_cert_pem) => onChange({ ...value, ca_cert_pem })}
				/>
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<div className="space-y-1">
					<Label>{t("mtlsCertificate")}</Label>
					<SecretVarInput
						variant="textarea"
						rows={4}
						placeholder="-----BEGIN CERTIFICATE-----"
						value={value.client_cert_pem}
						onChange={(client_cert_pem) => onChange({ ...value, client_cert_pem })}
					/>
				</div>
				<div className="space-y-1">
					<Label>{t("mtlsKey")}</Label>
					<SecretVarInput
						variant="textarea"
						rows={4}
						placeholder="-----BEGIN PRIVATE KEY-----"
						value={value.client_key_pem}
						onChange={(client_key_pem) => onChange({ ...value, client_key_pem })}
					/>
				</div>
			</div>
		</>
	);
}
function OAuthFields({ value, onChange }: { value: AgentOAuthConfig; onChange: (next: AgentOAuthConfig) => void }) {
	const { t } = useTranslation("agents");
	return (
		<div className="space-y-4">
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<div className="space-y-1">
					<Label>{t("providerUrl")}</Label>
					<Input
						value={value.provider_url ?? ""}
						placeholder="https://auth.example.com"
						onChange={(event) => onChange({ ...value, provider_url: event.target.value })}
					/>
				</div>
				<div className="space-y-1">
					<Label>{t("discoveryUrl")}</Label>
					<Input
						value={value.discovery_url ?? ""}
						placeholder="https://auth.example.com/.well-known/openid-configuration"
						onChange={(event) => onChange({ ...value, discovery_url: event.target.value })}
					/>
				</div>
			</div>
			<div className="space-y-1">
				<Label>{t("tokenUrl")}</Label>
				<Input
					value={value.token_url ?? ""}
					placeholder="https://auth.example.com/oauth/token"
					onChange={(event) => onChange({ ...value, token_url: event.target.value })}
				/>
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<div className="space-y-1">
					<Label>{t("clientId")}</Label>
					<SecretVarInput
						value={value.client_id}
						placeholder={t("clientIdPlaceholder")}
						onChange={(client_id) => onChange({ ...value, client_id })}
					/>
				</div>
				<div className="space-y-1">
					<Label>{t("clientSecret")}</Label>
					<SecretVarInput
						value={value.client_secret}
						placeholder={t("clientSecretPlaceholder")}
						onChange={(client_secret) => onChange({ ...value, client_secret })}
					/>
				</div>
			</div>
			<div className="space-y-1">
				<Label>{t("scopes")}</Label>
				<Input
					value={value.scopes?.join(" ") ?? ""}
					placeholder="read write"
					onChange={(event) => onChange({ ...value, scopes: event.target.value.split(/\s+/).filter(Boolean) })}
				/>
			</div>
			<div className="space-y-1">
				<Label>{t("resource")}</Label>
				<Input
					value={value.resource ?? ""}
					placeholder="https://agent.example.com"
					onChange={(event) => onChange({ ...value, resource: event.target.value })}
				/>
			</div>
		</div>
	);
}
function AuthFields({
	value,
	onChange,
	readOnlyAuth = false,
	disabled = false,
	requiredHeaderKeys = [],
}: {
	value: AgentUpstreamAuth;
	onChange: (next: AgentUpstreamAuth) => void;
	readOnlyAuth?: boolean;
	disabled?: boolean;
	requiredHeaderKeys?: string[];
}) {
	const { t } = useTranslation("agents");
	const changeKind = (type: AgentAuthType) =>
		onChange({
			...emptyAuth(),
			type,
			oauth: type === "oauth" ? (value.oauth ?? { client_id: emptySecret(), client_secret: emptySecret() }) : undefined,
			tls: value.tls,
			advanced: value.advanced,
		});
	return (
		<fieldset disabled={disabled} className="space-y-4 disabled:opacity-70">
			<div className="space-y-2">
				<Label>{t("authType")}</Label>
				<Select value={value.type} onValueChange={changeKind} disabled={readOnlyAuth}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={t("selectAuthType")} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="none">{t("none")}</SelectItem>
						<SelectItem value="headers">{t("headers")}</SelectItem>
						<SelectItem value="oauth">{t("oauthClientCredentials")}</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{value.type === "headers" && (
				<div className="space-y-4">
					{requiredHeaderKeys.length > 0 && (
						<HeadersTable
							value={value.headers ?? {}}
							onChange={(headers) => onChange({ ...value, headers })}
							fixedKeys={requiredHeaderKeys}
							useSecretVarInput
							label={t("advertisedHeaders")}
						/>
					)}
					<HeadersTable
						value={Object.fromEntries(Object.entries(value.headers ?? {}).filter(([name]) => !requiredHeaderKeys.includes(name)))}
						onChange={(headers) =>
							onChange({
								...value,
								headers: {
									...Object.fromEntries(Object.entries(value.headers ?? {}).filter(([name]) => requiredHeaderKeys.includes(name))),
									...headers,
								},
							})
						}
						useSecretVarInput
						label={t("extraHeaders")}
					/>
				</div>
			)}
			{value.type === "oauth" && (
				<div className="space-y-4">
					<OAuthFields value={value.oauth ?? {}} onChange={(oauth) => onChange({ ...value, oauth })} />
					<HeadersTable
						value={value.headers ?? {}}
						onChange={(headers) => onChange({ ...value, headers })}
						useSecretVarInput
						label={t("extraHeaders")}
					/>
				</div>
			)}
		</fieldset>
	);
}
interface AgentSheetProps {
	agent?: AgentRegistrationView;
	onClose: () => void;
	onSaved: () => void;
}
/** 展示注册表单与卡片预览，保留认证配置和授权提交逻辑。 */
export default function AgentSheet({ agent, onClose, onSaved }: AgentSheetProps) {
	const { t } = useTranslation("agents");
	const isEditing = !!agent;
	const [createAgent, { isLoading: isCreating }] = useCreateAgentMutation();
	const [updateAgent, { isLoading: isUpdating }] = useUpdateAgentMutation();
	const [inspectCard, { isLoading: isInspecting }] = useInspectAgentCardMutation();
	const { toast } = useToast();
	const [name, setName] = useState(agent?.name ?? "");
	const [nameError, setNameError] = useState<string | null>(null);
	const [agentCardUrl, setAgentCardUrl] = useState(agent?.agent_card_url ?? "");
	const [agentCardUrlError, setAgentCardUrlError] = useState<string | null>(null);
	const [cardAuth, setCardAuth] = useState<AgentUpstreamAuth>(agent?.discovery_auth ?? emptyAuth());
	const [runtimeAuth, setRuntimeAuth] = useState<AgentUpstreamAuth>(agent?.runtime_auth ?? emptyAuth());
	const [inspection, setInspection] = useState<InspectAgentCardResponse | null>(null);
	const [inspectionError, setInspectionError] = useState<string | null>(null);
	const [selectedRequirement, setSelectedRequirement] = useState(0);
	const [manualMode, setManualMode] = useState(agent?.runtime_auth?.advanced ?? false);
	const [cardTLSOpen, setCardTLSOpen] = useState(hasTLS(agent?.discovery_auth?.tls));
	const [runtimeTLSOpen, setRuntimeTLSOpen] = useState(hasTLS(agent?.runtime_auth?.tls));
	const [skillsOpen, setSkillsOpen] = useState(false);
	const [allowByDefault, setAllowByDefault] = useState(agent?.allow_by_default ?? false);
	const [forwardAcceptedCredential, setForwardAcceptedCredential] = useState(agent?.forward_accepted_credential ?? false);
	const [forwardAcceptedCredentialOverridesAuth, setForwardAcceptedCredentialOverridesAuth] = useState(
		agent?.forward_accepted_credential_overrides_auth ?? false,
	);
	const [virtualKeyIds, setVirtualKeyIds] = useState(agent?.virtual_key_ids ?? []);
	const [tenant, setTenant] = useState(agent?.tenant ?? "");
	const [extensionUris, setExtensionUris] = useState(agent?.extension_uris ?? []);
	const [advancedOpen, setAdvancedOpen] = useState(
		!!agent?.tenant || !!agent?.runtime_auth?.advanced || (agent?.extension_uris?.length ?? 0) > 0,
	);
	const { data: vksData } = useGetVirtualKeysQuery({ limit: 1000 });
	const vkById = new Map((vksData?.virtual_keys ?? []).map((virtualKey) => [virtualKey.id, virtualKey]));
	const { data: coreConfig } = useGetCoreConfigQuery({ fromDB: true });
	const baseUrl = getExternalBaseUrl(coreConfig?.client_config);
	const grpc = coreConfig?.agent_gateway
		? {
				baseDomain: coreConfig.agent_gateway.grpc_base_domain,
				port: coreConfig.agent_gateway.grpc_port,
			}
		: undefined;
	const applyRequirement = (result: InspectAgentCardResponse, index: number) => {
		setSelectedRequirement(index);
		const next = authForRequirement(result, index);
		if (!next) return;
		setRuntimeAuth((current) => ({
			...next,
			headers: Object.fromEntries(
				Object.entries(next.headers ?? {}).map(([header, empty]) => [header, current.headers?.[header] ?? empty]),
			),
			oauth:
				next.oauth && current.type === "oauth"
					? {
							...next.oauth,
							client_id: current.oauth?.client_id ?? next.oauth.client_id,
							client_secret: current.oauth?.client_secret ?? next.oauth.client_secret,
							token_url: next.oauth.token_url ?? current.oauth?.token_url,
						}
					: next.oauth,
			tls: current.tls ?? next.tls,
		}));
	};
	const handleInspect = async () => {
		if (!agentCardUrl.trim() || !/^https?:\/\//i.test(agentCardUrl.trim())) {
			setAgentCardUrlError(t("validUrl"));
			return;
		}
		setInspectionError(null);
		try {
			const result = await inspectCard({
				agent_card_url: agentCardUrl.trim(),
				discovery_auth: normalizeAuth(cardAuth),
			}).unwrap();
			setInspection(result);
			applyRequirement(result, 0);
		} catch (error) {
			setInspectionError(getErrorMessage(error));
		}
	};
	const selectedAuth = inspection ? authForRequirement(inspection, selectedRequirement) : null;
	const selectedRequirementNames = inspection?.security_requirements[selectedRequirement] ?? [];
	const requiredHeaderKeys = selectedRequirementNames
		.map((name) => inspection?.security_schemes.find((scheme) => scheme.name === name))
		.map((scheme) => (scheme ? headerName(scheme) : null))
		.filter((name): name is string => !!name);
	const unsupportedRequirement = !!inspection && !selectedAuth;
	const unsupportedReason = inspection && unsupportedRequirement ? requirementGap(inspection, selectedRequirement, t) : null;
	const expectedSchemes = selectedAuth?.security_schemes ?? [];
	const authMismatch =
		!!inspection &&
		expectedSchemes.length > 0 &&
		(expectedSchemes.length !== runtimeAuth.security_schemes?.length ||
			expectedSchemes.some((name) => !runtimeAuth.security_schemes?.includes(name)));
	const isBlocked = !manualMode && ((!isEditing && !inspection) || unsupportedRequirement);
	const handleSave = async () => {
		const validation = validateAgentName(name, t);
		if (validation) {
			setNameError(validation);
			return;
		}
		if (!agentCardUrl.trim() || !/^https?:\/\//i.test(agentCardUrl.trim())) {
			setAgentCardUrlError(t("validUrl"));
			return;
		}
		if (isBlocked) {
			setInspectionError(unsupportedRequirement ? (unsupportedReason ?? t("cannotExecuteRequirement")) : t("fetchOrManual"));
			return;
		}
		const payload = {
			agent_card_url: agentCardUrl.trim(),
			tenant: tenant.trim() || undefined,
			allow_by_default: allowByDefault,
			forward_accepted_credential: forwardAcceptedCredential,
			forward_accepted_credential_overrides_auth: forwardAcceptedCredentialOverridesAuth,
			discovery_auth: normalizeAuth(cardAuth),
			runtime_auth: normalizeAuth({ ...runtimeAuth, advanced: manualMode }),
			virtual_key_ids: virtualKeyIds,
			extension_uris: extensionUris.map((uri) => uri.trim()).filter(Boolean),
		};
		try {
			if (agent)
				await updateAgent({
					name: agent.name,
					data: { ...payload, enabled: agent.enabled },
				}).unwrap();
			else await createAgent({ name, enabled: true, ...payload }).unwrap();
			toast({ title: t("success"), description: agent ? t("agentUpdated") : t("agentRegistered") });
			onSaved();
		} catch (error) {
			toast({
				title: t("saveAgentFailed"),
				description: getErrorMessage(error),
				variant: "destructive",
			});
		}
	};
	return (
		<Sheet open onOpenChange={(open) => !open && onClose()}>
			<SheetContent
				className="flex w-full flex-col gap-4 overflow-x-hidden p-0 pt-4 sm:max-w-[40rem]"
				onInteractOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={onClose}
			>
				<SheetHeader className="w-full flex-col items-start gap-1 p-0 py-4" headerClassName="mb-0 sticky -top-4 bg-card z-10 px-4 md:px-8">
					<SheetTitle className="font-medium">{name.trim() || t("newAgent")}</SheetTitle>
					<SheetDescription className="line-clamp-2">{inspection?.description || t("registerDescription")}</SheetDescription>
				</SheetHeader>
				<div className="grow space-y-6 px-4 pb-6 md:px-8">
					<div className="space-y-4">
						<SectionHeader title={t("basicInformation")} description={t("basicInformationDescription")} />
						<div className="space-y-2">
							<Label>{t("name")}</Label>
							<Input
								value={name}
								placeholder="accounting-agent"
								disabled={isEditing}
								onChange={(event) => {
									setName(event.target.value);
									setNameError(event.target.value ? validateAgentName(event.target.value, t) : null);
								}}
							/>
							{nameError && <p className="text-destructive text-sm">{nameError}</p>}
							{grpc && name.length > 63 && (
								<Alert variant="warning" data-testid="agent-grpc-name-length-warning">
									<AlertTriangle className="h-4 w-4" />
									<AlertTitle>{t("grpcUnavailable")}</AlertTitle>
									<AlertDescription>{t("grpcNameLimit")}</AlertDescription>
								</Alert>
							)}
						</div>
						<div className="space-y-2">
							<Label>{t("agentCardUrl")}</Label>
							<div className="flex gap-2">
								<Input
									value={agentCardUrl}
									placeholder="https://agent.example.com/.well-known/agent-card.json"
									onChange={(event) => {
										setAgentCardUrl(event.target.value);
										setAgentCardUrlError(null);
										setInspection(null);
									}}
								/>
								<Button
									type="button"
									variant="outline"
									className="h-9 shrink-0 self-end"
									onClick={() => void handleInspect()}
									isLoading={isInspecting}
									disabled={!agentCardUrl.trim()}
								>
									<RefreshCw className="h-4 w-4" />
									{t("fetchCard")}
								</Button>
							</div>
							{agentCardUrlError && <p className="text-destructive text-sm">{agentCardUrlError}</p>}
						</div>
					</div>
					<div className="space-y-4">
						<SectionHeader title={t("cardAuth")} description={t("cardAuthDescription")} />
						<AuthFields
							value={cardAuth}
							onChange={(next) => {
								setCardAuth(next);
								setInspection(null);
							}}
						/>
					</div>
					<Collapsible open={cardTLSOpen} onOpenChange={setCardTLSOpen}>
						<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 py-1 text-left">
							<div>
								<p className="text-sm font-medium">{t("cardTls")}</p>
								<p className="text-muted-foreground text-sm">{t("cardTlsDescription")}</p>
							</div>
							{cardTLSOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
						</CollapsibleTrigger>
						<CollapsibleContent className="pt-4">
							<div className="space-y-4 rounded-md border p-4">
								<TLSFields
									value={cardAuth.tls ?? {}}
									onChange={(tls) => {
										setCardAuth({ ...cardAuth, tls });
										setInspection(null);
									}}
								/>
							</div>
						</CollapsibleContent>
					</Collapsible>
					{inspectionError && (
						<div className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">{inspectionError}</div>
					)}
					{!inspection && !inspectionError && (
						<div className="text-muted-foreground rounded-md border border-dashed p-5 text-center text-sm">
							{isInspecting ? t("fetchingCard") : t("fetchCardPreview")}
						</div>
					)}
					{inspection && (
						<div className="space-y-4 rounded-md border p-4">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<p className="font-medium">{inspection.name || t("cardFetched")}</p>
										{inspection.version && <Badge variant="outline">v{inspection.version}</Badge>}
									</div>
									{inspection.provider && (
										<p className="text-muted-foreground text-sm">
											{t("providedBy")}{" "}
											{inspection.provider_url ? (
												<a href={inspection.provider_url} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
													{inspection.provider}
												</a>
											) : (
												inspection.provider
											)}
										</p>
									)}
									{inspection.documentation_url && (
										<a
											href={inspection.documentation_url}
											target="_blank"
											rel="noreferrer"
											className="text-muted-foreground block text-xs hover:underline"
										>
											{t("documentation")}
										</a>
									)}
								</div>
								<Badge variant="success">{t("ready")}</Badge>
							</div>
							<div className="grid grid-cols-2 gap-3 text-sm">
								<div>
									<p className="text-muted-foreground text-xs">{t("interfaces")}</p>
									<p>{inspection.interfaces?.length ?? 0}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">{t("skills")}</p>
									<p>{inspection.skills?.length ?? 0}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">{t("signatures")}</p>
									<p>{inspection.signature_count}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">{t("inputModes")}</p>
									<p className="break-all">{inspection.default_input_modes?.join(", ") || t("notDeclared")}</p>
								</div>
								<div>
									<p className="text-muted-foreground text-xs">{t("outputModes")}</p>
									<p className="break-all">{inspection.default_output_modes?.join(", ") || t("notDeclared")}</p>
								</div>
							</div>
							{Object.values(inspection.capabilities).some(Boolean) && (
								<div className="space-y-2">
									<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("capabilities")}</p>
									<div className="flex flex-wrap gap-2">
										{Object.entries(inspection.capabilities)
											.sort(([left], [right]) => left.localeCompare(right))
											.map(([name, supported]) => (
												<Badge
													key={name}
													variant={supported ? "default" : "outline"}
													className={supported ? undefined : "text-muted-foreground line-through opacity-60"}
													title={supported ? t("supported") : t("notSupported")}
												>
													{capabilityLabel(name, t)}
												</Badge>
											))}
									</div>
									{inspection.capabilities.extendedAgentCard && (
										<p className="text-muted-foreground text-xs leading-relaxed">{t("extendedCardDescription")}</p>
									)}
								</div>
							)}
							{inspection.interfaces && inspection.interfaces.length > 0 && (
								<div className="space-y-2">
									<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("interfaces")}</p>
									{inspection.interfaces.map((item) => (
										<div key={`${item.protocol_binding}-${item.url}`} className="flex items-start justify-between gap-3 text-sm">
											<span className="font-medium">{item.protocol_binding}</span>
											<span className="text-muted-foreground text-right break-all">
												{item.protocol_version} · {item.url}
												{item.tenant && (
													<span className="block">
														{t("tenant")}: {item.tenant}
													</span>
												)}
											</span>
										</div>
									))}
								</div>
							)}
							<div className="space-y-2">
								<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("advertisedAuth")}</p>
								<div className="flex flex-wrap gap-2">
									{inspection.security_requirements.length === 0 ? (
										<Badge variant="outline">{t("none")}</Badge>
									) : (
										inspection.security_requirements.map((requirement, index) => (
											<Badge key={`${requirement.join("-")}-${index}`} variant="outline">
												{requirement.length ? requirement.join(" + ") : t("none")}
											</Badge>
										))
									)}
								</div>
							</div>
							{inspection.extensions && inspection.extensions.length > 0 && (
								<div className="space-y-2">
									<p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t("extensions")}</p>
									<div className="flex flex-wrap gap-2">
										{inspection.extensions.map((extension) => (
											<TooltipProvider key={extension.uri}>
												<Tooltip>
													<TooltipTrigger asChild>
														<Badge variant={extension.required ? "warning" : "outline"}>{extension.uri}</Badge>
													</TooltipTrigger>
													{(extension.description || extension.params) && (
														<TooltipContent className="max-w-80">
															{extension.description && <p>{extension.description}</p>}
															{extension.params && (
																<pre className="mt-1 text-xs whitespace-pre-wrap">{JSON.stringify(extension.params, null, 2)}</pre>
															)}
														</TooltipContent>
													)}
												</Tooltip>
											</TooltipProvider>
										))}
									</div>
								</div>
							)}
							{inspection.skills && inspection.skills.length > 0 && (
								<Collapsible open={skillsOpen} onOpenChange={setSkillsOpen}>
									<CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-medium">
										<span>{t("skillsCount", { count: inspection.skills.length })}</span>
										{skillsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
									</CollapsibleTrigger>
									<CollapsibleContent className="space-y-3 pt-3">
										{inspection.skills.map((skill) => (
											<div key={skill.id} className="space-y-1 border-t pt-3 first:border-0 first:pt-0">
												<p className="text-sm font-medium">{skill.name}</p>
												{skill.description && <p className="text-muted-foreground text-xs">{skill.description}</p>}
												{skill.tags && skill.tags.length > 0 && (
													<p className="text-muted-foreground line-clamp-2 text-xs">{skill.tags.join(", ")}</p>
												)}
												{(skill.input_modes?.length || skill.output_modes?.length) && (
													<p className="text-muted-foreground text-xs">
														{skill.input_modes?.length ? t("inputValue", { value: skill.input_modes.join(", ") }) : ""}
														{skill.input_modes?.length && skill.output_modes?.length ? " · " : ""}
														{skill.output_modes?.length ? t("outputValue", { value: skill.output_modes.join(", ") }) : ""}
													</p>
												)}
												{skill.security_requirements && skill.security_requirements.length > 0 && (
													<p className="text-muted-foreground text-xs">
														{t("authentication")}:{" "}
														{skill.security_requirements.map((requirement) => requirement.join(" + ") || t("none")).join(t("or"))}
													</p>
												)}
												{skill.examples && skill.examples.length > 0 && (
													<div className="text-muted-foreground text-xs">
														<p className="font-medium">{t("examples")}</p>
														<ul className="list-disc space-y-0.5 pl-4">
															{skill.examples.map((example) => (
																<li key={example}>{example}</li>
															))}
														</ul>
													</div>
												)}
											</div>
										))}
									</CollapsibleContent>
								</Collapsible>
							)}
							{inspection.warnings?.map((warning) => (
								<p key={warning} className="text-sm text-amber-700">
									{warning}
								</p>
							))}
						</div>
					)}
					<DottedSeparator />
					<div className="space-y-4">
						<SectionHeader
							title={`${t("requestAuth")}${isEditing && !inspection && !manualMode ? t("refetchToEdit") : ""}`}
							description={t("requestAuthDescription")}
						/>
						{inspection && inspection.security_requirements.length > 1 && (
							<div className="space-y-1">
								<Label>{t("securityRequirement")}</Label>
								<Select value={String(selectedRequirement)} onValueChange={(value) => applyRequirement(inspection, Number(value))}>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{inspection.security_requirements.map((requirement, index) => (
											<SelectItem key={index} value={String(index)}>
												{requirement.length ? requirement.join(" + ") : t("none")}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						{!inspection && !manualMode && !isEditing && (
							<div className="text-muted-foreground rounded-md border border-dashed p-5 text-center text-sm">{t("fetchCardAuth")}</div>
						)}
						{(selectedAuth || manualMode || isEditing) && (
							<AuthFields
								value={runtimeAuth}
								onChange={setRuntimeAuth}
								readOnlyAuth={!manualMode}
								disabled={isEditing && !inspection && !manualMode}
								requiredHeaderKeys={manualMode ? [] : requiredHeaderKeys}
							/>
						)}
						<div className="rounded-md border">
							<div className="flex items-center justify-between gap-4 p-3">
								<div className="space-y-0.5">
									<Label>{t("forwardAuth")}</Label>
									<p className="text-muted-foreground text-sm">{t("forwardAuthDescription")}</p>
								</div>
								<Switch aria-label={t("forwardAuth")} checked={forwardAcceptedCredential} onCheckedChange={setForwardAcceptedCredential} />
							</div>
							{forwardAcceptedCredential && (
								<div className="bg-muted/30 space-y-2 border-t p-3">
									<Label>{t("authHeadersConflict")}</Label>
									<Select
										value={forwardAcceptedCredentialOverridesAuth ? "incoming" : "configured"}
										onValueChange={(value) => setForwardAcceptedCredentialOverridesAuth(value === "incoming")}
									>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="configured">{t("configuredAuth")}</SelectItem>
											<SelectItem value="incoming">{t("incomingAuth")}</SelectItem>
										</SelectContent>
									</Select>
									<p className="text-muted-foreground text-sm">{t("authConflictDescription")}</p>
								</div>
							)}
						</div>
						{unsupportedReason && !manualMode && <p className="text-destructive text-sm">{unsupportedReason}</p>}
						{authMismatch && !manualMode && <p className="text-sm text-amber-700">{t("authMismatch")}</p>}
					</div>
					<Collapsible open={runtimeTLSOpen} onOpenChange={setRuntimeTLSOpen}>
						<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 py-1 text-left">
							<div>
								<p className="text-sm font-medium">{t("runtimeTls")}</p>
								<p className="text-muted-foreground text-sm">{t("runtimeTlsDescription")}</p>
							</div>
							{runtimeTLSOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
						</CollapsibleTrigger>
						<CollapsibleContent className="pt-4">
							<div className="space-y-4 rounded-md border p-4">
								<TLSFields value={runtimeAuth.tls ?? {}} onChange={(tls) => setRuntimeAuth({ ...runtimeAuth, tls })} />
							</div>
						</CollapsibleContent>
					</Collapsible>
					<DottedSeparator />
					<div className="space-y-4">
						<SectionHeader title={t("behavior")} description={t("behaviorDescription")} />
						<div className="divide-y rounded-md border">
							<div className="flex items-center justify-between p-3">
								<div className="flex items-center gap-2">
									<Label>{t("allowByDefault")}</Label>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Info className="text-muted-foreground h-4 w-4" />
											</TooltipTrigger>
											<TooltipContent>{t("anyVirtualKey")}</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<Switch aria-label={t("allowByDefault")} checked={allowByDefault} onCheckedChange={setAllowByDefault} />
							</div>
						</div>
					</div>
					<div className="space-y-4">
						<SectionHeader
							title={t("virtualKeyGrants")}
							description={t("virtualKeyGrantsDescription")}
							action={
								<VirtualKeySelector
									mode="add"
									excludeIds={virtualKeyIds}
									onSelect={(option) => setVirtualKeyIds((current) => [...current, option.value])}
									trigger={
										<Button type="button" variant="outline" size="sm">
											<Plus className="h-4 w-4" />
											{t("addVirtualKey")}
										</Button>
									}
								/>
							}
						/>
						{virtualKeyIds.length === 0 ? (
							<div className="text-muted-foreground rounded-md border border-dashed p-5 text-center text-sm">
								{allowByDefault ? t("everyVirtualKey") : t("noVirtualKeyGrants")}
							</div>
						) : (
							<div className="divide-y rounded-md border">
								{virtualKeyIds.map((id) => (
									<VirtualKeyListItem
										key={id}
										name={vkById.get(id)?.name}
										secret={vkById.get(id)?.value}
										fallbackLabel={id}
										onRemove={() => setVirtualKeyIds((current) => current.filter((value) => value !== id))}
										removeAriaLabel={t("revokeGrant")}
									/>
								))}
							</div>
						)}
					</div>
					<DottedSeparator />
					<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
						<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 py-1 text-left">
							<p className="text-sm font-medium">{t("advancedSettings")}</p>
							{advancedOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-5 pt-4">
							<div className="flex items-center justify-between rounded-md border p-3">
								<div>
									<Label>{t("manualAuth")}</Label>
									<p className="text-muted-foreground text-xs">{t("manualAuthDescription")}</p>
								</div>
								<Switch
									aria-label={t("manualAuth")}
									checked={manualMode}
									onCheckedChange={(checked) => {
										setManualMode(checked);
										setRuntimeAuth((current) => ({ ...current, advanced: checked }));
									}}
								/>
							</div>
							<div className="space-y-1">
								<Label>{t("optionalTenant")}</Label>
								<p className="text-muted-foreground text-xs">{t("tenantDescription")}</p>
								<Input value={tenant} placeholder="tenant-a" onChange={(event) => setTenant(event.target.value)} />
							</div>
							<div className="space-y-3">
								<div className="flex items-start justify-between gap-3">
									<div className="space-y-1">
										<Label>{t("extensionUris")}</Label>
										<p className="text-muted-foreground text-xs">{t("extensionUrisDescription")}</p>
									</div>
									<Button type="button" variant="outline" size="sm" onClick={() => setExtensionUris((current) => [...current, ""])}>
										<Plus className="h-4 w-4" />
										{t("addUri")}
									</Button>
								</div>
								{extensionUris.map((uri, index) => (
									<div key={index} className="flex gap-2">
										<Input
											value={uri}
											placeholder="https://example.com/a2a/extensions/audit"
											onChange={(event) =>
												setExtensionUris((current) => current.map((value, itemIndex) => (itemIndex === index ? event.target.value : value)))
											}
										/>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={t("removeUri")}
											onClick={() => setExtensionUris((current) => current.filter((_, itemIndex) => itemIndex !== index))}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</div>
								))}
							</div>
						</CollapsibleContent>
					</Collapsible>
					{agent && (
						<>
							<DottedSeparator />
							<AgentEndpoints agentName={agent.name} baseUrl={baseUrl} grpc={grpc} />
							<></>
						</>
					)}
				</div>
				<div className="bg-card sticky bottom-0 flex justify-end gap-2 border-t px-4 py-4 md:px-8">
					<Button type="button" variant="outline" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						onClick={() => void handleSave()}
						disabled={isCreating || isUpdating || !!nameError || !name || !agentCardUrl}
						isLoading={isCreating || isUpdating}
					>
						{agent ? t("saveChanges") : t("create")}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}