import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { HeadersTable } from "@/components/ui/headersTable";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DottedSeparator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import i18n from "@/lib/i18n";
import { CreateMCPClientRequest, MCPAuthType, MCPConnectionType, MCPTLSConfig, SecretVar } from "@/lib/types/mcp";
import { parseArrayFromText } from "@/lib/utils/array";
import { Info } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UseFormReturn } from "react-hook-form";
import { SectionHeader } from "./sectionHeader";
/**
 * Shared configuration body for creating an MCP client. Rendered identically by
 * the catalog's "New MCP Server" sheet and the library's install sheet, so the
 * two surfaces can never drift in layout, copy, or supported auth types. The
 * install sheet passes `lockConnection` because its transport and target come
 * from the library entry the form was seeded with.
 */
const emptySecretVar: SecretVar = { value: "", ref: "" };
export type MCPAuthKind = "none" | "headers" | "oauth" | "token_exchange";
export type MCPAuthScope = "shared" | "per_user";
/** Resolve the wire `auth_type` back into the two dropdowns the UI splits it into. */
export function authKindOf(authType: MCPAuthType | undefined): MCPAuthKind {
	switch (authType) {
		case "oauth":
		case "per_user_oauth":
			return "oauth";
		case "headers":
		case "per_user_headers":
			return "headers";
		default:
			return "none";
	}
}
export function authScopeOf(authType: MCPAuthType | undefined): MCPAuthScope {
	return authType === "per_user_oauth" || authType === "per_user_headers" ? "per_user" : "shared";
}
/**
 * Form values that live outside react-hook-form: comma-separated text inputs
 * whose parsed form is only needed at submit time, plus the auth scope half of
 * the split auth dropdowns.
 */
export interface MCPClientFormSatellites {
	argsText: string;
	setArgsText: (value: string) => void;
	envVars: Record<string, string>;
	setEnvVars: (value: Record<string, string>) => void;
	scopesText: string;
	setScopesText: (value: string) => void;
	tokenExchangeScopesText: string;
	setTokenExchangeScopesText: (value: string) => void;
	resourceText: string;
	setResourceText: (value: string) => void;
	perUserHeaderKeys: string[];
	headerKeysInput: string;
	setHeaderKeysInput: (value: string) => void;
	allowedExtraHeadersText: string;
	setAllowedExtraHeadersText: (value: string) => void;
	authScope: MCPAuthScope;
	setAuthScope: (value: MCPAuthScope) => void;
	reset: (init?: MCPClientFormSatellitesInit) => void;
}
export interface MCPClientFormSatellitesInit {
	argsText?: string;
	envVars?: Record<string, string>;
	perUserHeaderKeys?: string[];
	allowedExtraHeaders?: string[];
	authScope?: MCPAuthScope;
}
export function useMCPClientFormSatellites(): MCPClientFormSatellites {
	const [argsText, setArgsText] = useState("");
	const [envVars, setEnvVars] = useState<Record<string, string>>({});
	const [scopesText, setScopesText] = useState("");
	const [tokenExchangeScopesText, setTokenExchangeScopesText] = useState("");
	const [resourceText, setResourceText] = useState("");
	const [headerKeysInput, setHeaderKeysInput] = useState("");
	const [allowedExtraHeadersText, setAllowedExtraHeadersText] = useState("");
	const [authScope, setAuthScope] = useState<MCPAuthScope>("shared");
	const reset = useCallback((init?: MCPClientFormSatellitesInit) => {
		setArgsText(init?.argsText ?? "");
		setEnvVars(init?.envVars ?? {});
		setScopesText("");
		setTokenExchangeScopesText("");
		setResourceText("");
		setHeaderKeysInput((init?.perUserHeaderKeys ?? []).join(", "));
		setAllowedExtraHeadersText((init?.allowedExtraHeaders ?? []).join(", "));
		setAuthScope(init?.authScope ?? "shared");
	}, []);
	return {
		argsText,
		setArgsText,
		envVars,
		setEnvVars,
		scopesText,
		setScopesText,
		tokenExchangeScopesText,
		setTokenExchangeScopesText,
		resourceText,
		setResourceText,
		// Derived rather than stored: the textarea is the single source of truth,
		// so the parsed list can never fall out of sync with what's on screen.
		perUserHeaderKeys: parseArrayFromText(headerKeysInput),
		headerKeysInput,
		setHeaderKeysInput,
		allowedExtraHeadersText,
		setAllowedExtraHeadersText,
		authScope,
		setAuthScope,
		reset,
	};
}
/** Strips empty TLS config so we don't send `{}` to the server. */
export function buildTLSConfigPayload(tls: MCPTLSConfig | undefined): MCPTLSConfig | undefined {
	if (!tls) return undefined;
	const hasSkipVerify = tls.insecure_skip_verify === true;
	const hasCACert = tls.ca_cert_pem?.value || tls.ca_cert_pem?.type === "env" || tls.ca_cert_pem?.type === "vault";
	if (!hasSkipVerify && !hasCACert) return undefined;
	return {
		insecure_skip_verify: tls.insecure_skip_verify,
		ca_cert_pem: hasCACert ? tls.ca_cert_pem : undefined,
	};
}
export function isValidOAuthResourceURI(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol !== "" && parsed.hash === "";
	} catch {
		return false;
	}
}
/** 校验所有鉴权类型的静态请求头，缺值时返回本地化错误。 */
export function getHeadersValidationError(headers: Record<string, SecretVar> | undefined): string | null {
	if (!headers) return null;
	for (const [key, secretVar] of Object.entries(headers)) {
		if (!secretVar.value && !secretVar.ref) {
			return i18n.t("registry.form.headerMustHaveValue", { ns: "mcp", key });
		}
	}
	return null;
}
/** 提交前校验连接、鉴权与额外请求头；安装目录条目时跳过固定连接字段。 */
export function validateMCPClientForm({
	data,
	satellites,
	form,
	skipConnection,
	onToast,
}: {
	data: CreateMCPClientRequest;
	satellites: MCPClientFormSatellites;
	form: UseFormReturn<CreateMCPClientRequest>;
	skipConnection?: boolean;
	onToast: (title: string, description: string) => void;
}): boolean {
	const { setError } = form;
	const connectionType = data.connection_type;
	const authType = data.auth_type;
	let hasErrors = false;
	if (!skipConnection && (connectionType === "http" || connectionType === "sse")) {
		const connVal = data.connection_string?.value?.trim() || "";
		const connRef = data.connection_string?.ref?.trim() || "";
		const isSecret = data.connection_string?.type === "env" || data.connection_string?.type === "vault";
		if (!connVal && !connRef) {
			setError("connection_string", {
				message: i18n.t("registry.form.connectionUrlRequired", { ns: "mcp" }),
			});
			hasErrors = true;
		} else if (!isSecret && connVal && !/^https?:\/\/.+/.test(connVal)) {
			setError("connection_string", {
				message: i18n.t("registry.form.connectionUrlHttp", { ns: "mcp" }),
			});
			hasErrors = true;
		}
	}
	if (!skipConnection && connectionType === "stdio") {
		const cmd = data.stdio_config?.command || "";
		if (!cmd.trim()) {
			setError("stdio_config.command", {
				message: i18n.t("registry.form.commandRequiredStdio", { ns: "mcp" }),
			});
			hasErrors = true;
		} else if (/[<>|&;]/.test(cmd)) {
			setError("stdio_config.command", {
				message: i18n.t("registry.form.commandShellChars", { ns: "mcp" }),
			});
			hasErrors = true;
		}
	}
	if (authType === "oauth" || authType === "per_user_oauth") {
		if (data.oauth_config?.authorize_url && !/^https?:\/\/.+$/.test(data.oauth_config.authorize_url)) {
			setError("oauth_config.authorize_url", {
				message: i18n.t("registry.form.authorizeUrlHttp", { ns: "mcp" }),
			});
			hasErrors = true;
		}
		if (data.oauth_config?.token_url && !/^https?:\/\/.+$/.test(data.oauth_config.token_url)) {
			setError("oauth_config.token_url", {
				message: i18n.t("registry.form.tokenUrlHttp", { ns: "mcp" }),
			});
			hasErrors = true;
		}
		if (data.oauth_config?.registration_url && !/^https?:\/\/.+$/.test(data.oauth_config.registration_url)) {
			setError("oauth_config.registration_url", {
				message: i18n.t("registry.form.registrationUrlHttp", { ns: "mcp" }),
			});
			hasErrors = true;
		}
		if (satellites.resourceText.trim() && !isValidOAuthResourceURI(satellites.resourceText.trim())) {
			onToast(i18n.t("registry.form.invalidResourceTitle", { ns: "mcp" }), i18n.t("registry.form.invalidResourceDesc", { ns: "mcp" }));
			hasErrors = true;
		}
	}
	if (authType === "per_user_headers" && satellites.perUserHeaderKeys.length === 0) {
		onToast(i18n.t("registry.form.headerKeysRequiredTitle", { ns: "mcp" }), i18n.t("registry.form.headerKeysRequiredDesc", { ns: "mcp" }));
		hasErrors = true;
	}
	// Mirrors the server's WhiteList validation, which rejects "*" alongside names.
	// Skipped for STDIO, which hides the field and drops the value from the
	// payload: text left over from a network transport must not block submit.
	const allowedExtraHeaders = parseArrayFromText(satellites.allowedExtraHeadersText);
	if (connectionType !== "stdio" && allowedExtraHeaders.includes("*") && allowedExtraHeaders.length > 1) {
		onToast(
			i18n.t("registry.form.invalidExtraHeadersTitle", { ns: "mcp" }),
			i18n.t("registry.form.invalidExtraHeadersDescription", { ns: "mcp" }),
		);
		hasErrors = true;
	}
	return !hasErrors;
}
/**
 * Assembles the POST /api/mcp/client body from the form values plus the
 * satellite text inputs. Shared so a field wired into one sheet can never be
 * silently dropped by the other.
 */
export function buildMCPClientPayload(data: CreateMCPClientRequest, satellites: MCPClientFormSatellites): CreateMCPClientRequest {
	const connectionType = data.connection_type;
	const authType = data.auth_type;
	const isStdio = connectionType === "stdio";
	return {
		...data,
		connection_string: isStdio ? undefined : data.connection_string,
		stdio_config: isStdio
			? {
					command: data.stdio_config?.command || "",
					args: parseArrayFromText(satellites.argsText),
					// Each row becomes KEY=value, or a bare KEY when no value is given
					// (read from Bifrost's host environment). Rows without a name are skipped.
					envs: Object.entries(satellites.envVars)
						.filter(([name]) => name.trim() !== "")
						.map(([name, value]) => {
							const trimmed = value.trim();
							return trimmed ? `${name}=${trimmed}` : name;
						}),
				}
			: undefined,
		tls_config: isStdio ? undefined : buildTLSConfigPayload(data.tls_config),
		oauth_config:
			authType === "oauth" || authType === "per_user_oauth"
				? {
						client_id: data.oauth_config?.client_id ?? emptySecretVar,
						client_secret:
							data.oauth_config?.client_secret?.value ||
							data.oauth_config?.client_secret?.type === "env" ||
							data.oauth_config?.client_secret?.type === "vault"
								? data.oauth_config.client_secret
								: undefined,
						authorize_url: data.oauth_config?.authorize_url || undefined,
						token_url: data.oauth_config?.token_url || undefined,
						registration_url: data.oauth_config?.registration_url || undefined,
						scopes: satellites.scopesText.trim() ? parseArrayFromText(satellites.scopesText) : undefined,
						server_url: data.connection_string?.value || undefined,
						resource: satellites.resourceText.trim() || undefined,
					}
				: undefined,
		// Every network auth type can carry static admin headers on data.headers
		// (per-user values are submitted separately by end users); STDIO has no
		// request headers to send.
		headers: !isStdio && data.headers && Object.keys(data.headers).length > 0 ? data.headers : undefined,
		per_user_header_keys: authType === "per_user_headers" ? satellites.perUserHeaderKeys : undefined,
		tools_to_execute: ["*"],
		// Extra headers only ride on the network transports.
		allowed_extra_headers: isStdio ? undefined : parseArrayFromText(satellites.allowedExtraHeadersText),
	};
}
/**
 * Warns that STDIO servers shell out to the host, which only carries the usual
 * runtimes on the official image. Shown wherever a STDIO server is configured.
 */
export function StdioRuntimeNotice() {
	const { t } = useTranslation("mcp");
	return (
		<div className="rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="stdio-docker-notice">
			<div className="flex items-start gap-2">
				<Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
				<div className="flex-1">
					<p className="text-xs font-medium text-amber-900">{t("registry.form.dockerNotice")}</p>
					<p className="mt-0.5 text-xs text-amber-800">{t("registry.form.dockerNoticeBody")}</p>
				</div>
			</div>
		</div>
	);
}
interface MCPClientFormFieldsProps {
	form: UseFormReturn<CreateMCPClientRequest>;
	satellites: MCPClientFormSatellites;
	headersValidationError: string | null;
	/**
	 * Renders the transport, target, and STDIO launch command read-only. Set by
	 * the install sheet, where those values come from the library entry rather
	 * than from the person filling in the form.
	 */
	lockConnection?: boolean;
	/**
	 * STDIO variable names declared by the library entry. When set, the env
	 * table renders exactly these rows and only their values are editable.
	 */
	stdioEnvKeys?: string[];
}
export function MCPClientFormFields({ form, satellites, headersValidationError, lockConnection, stdioEnvKeys }: MCPClientFormFieldsProps) {
	const { t } = useTranslation("mcp");
	const { control, setValue, watch, clearErrors } = form;
	const connectionType = watch("connection_type");
	const authType = watch("auth_type");
	const authKind = authKindOf(authType);
	const { authScope, setAuthScope } = satellites;

	// auth-type validation, so the form can be seeded with an auth type this
	// deployment can't offer. The Select would then show its placeholder while

	const tokenExchangeUnavailable = false;
	/**
	 * The stickiness switch only renders for a shared http auth type. Picking an
	 * auth type that hides it has to drop any value chosen while it was visible,
	 * otherwise a stale `true` stays in form state and gets submitted. The
	 * connection-type handler below applies the same reset for non-http
	 * transports.
	 */
	const clearStickinessIfHidden = (kind: MCPAuthKind, scope: MCPAuthScope) => {
		if (kind !== "none" && scope === "per_user") {
			setValue("needs_session_stickiness", undefined);
		}
	};
	const applyAuthKind = (kind: MCPAuthKind) => {
		clearErrors();
		clearStickinessIfHidden(kind, authScope);
		if (kind === "none") {
			setValue("auth_type", kind);
			return;
		}
		if (kind === "oauth") {
			setValue("auth_type", authScope === "per_user" ? "per_user_oauth" : "oauth");
			return;
		}
		setValue("auth_type", authScope === "per_user" ? "per_user_headers" : "headers");
	};
	const applyAuthScope = (scope: MCPAuthScope) => {
		setAuthScope(scope);
		clearStickinessIfHidden(authKind, scope);
		if (authKind === "oauth") {
			setValue("auth_type", scope === "per_user" ? "per_user_oauth" : "oauth");
		} else if (authKind === "headers") {
			setValue("auth_type", scope === "per_user" ? "per_user_headers" : "headers");
		}
	};
	const isRemote = connectionType === "http" || connectionType === "sse";
	return (
		<>
			{/* Server Behavior */}
			<div className="space-y-4">
				<SectionHeader title={t("registry.form.serverBehavior")} description={t("registry.form.serverBehaviorDesc")} />
				<div className="divide-y rounded-md border">
					<FormField
						control={control}
						name="is_code_mode_client"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between gap-4 px-4 py-3">
								<div className="flex items-center gap-2">
									<FormLabel htmlFor="code-mode">{t("registry.form.codeModeServer")}</FormLabel>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<a
													href="https://docs.getbifrost.ai/mcp/code-mode"
													target="_blank"
													rel="noopener noreferrer"
													data-testid="code-mode-link-help"
													className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded focus-visible:ring-2 focus-visible:outline-none"
													aria-label={t("registry.form.learnCodeModeAria")}
												>
													<Info className="h-4 w-4 cursor-help" />
												</a>
											</TooltipTrigger>
											<TooltipContent>
												<p>{t("registry.form.learnCodeMode")}</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<FormControl>
									<Switch id="code-mode" data-testid="code-mode-switch" checked={field.value} onCheckedChange={field.onChange} />
								</FormControl>
							</FormItem>
						)}
					/>
					<FormField
						control={control}
						name="is_ping_available"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between gap-4 px-4 py-3">
								<div className="flex items-center gap-2">
									<FormLabel htmlFor="ping-available">{t("registry.form.pingAvailable")}</FormLabel>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Info className="text-muted-foreground h-4 w-4 cursor-help" />
											</TooltipTrigger>
											<TooltipContent className="max-w-xs">
												<p>{t("registry.form.pingAvailableHelp")}</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<FormControl>
									<Switch
										id="ping-available"
										data-testid="mcp-is-ping-available"
										checked={field.value === true}
										onCheckedChange={field.onChange}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
					{connectionType === "http" && authType !== "per_user_oauth" && authType !== "per_user_headers" && (
						<FormField
							control={control}
							name="needs_session_stickiness"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-4 px-4 py-3">
									<div className="flex items-center gap-2">
										<FormLabel htmlFor="needs-session-stickiness">{t("registry.form.persistentConnection")}</FormLabel>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Info className="text-muted-foreground h-4 w-4 cursor-help" />
												</TooltipTrigger>
												<TooltipContent className="max-w-xs">
													<p>{t("registry.form.persistentConnectionHelp")}</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									</div>
									<FormControl>
										<Switch
											id="needs-session-stickiness"
											data-testid="mcp-needs-session-stickiness"
											checked={field.value === true}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
					)}
				</div>
			</div>

			<DottedSeparator />

			{/* Connection & Authentication */}
			<div className="space-y-4">
				<SectionHeader
					title={t("registry.form.connectionAuth")}
					description={lockConnection ? t("registry.form.connectionAuthLocked") : t("registry.form.connectionAuthOpen")}
				/>
				<div className="space-y-4 rounded-md border p-4">
					<FormField
						control={control}
						name="connection_type"
						render={({ field }) => (
							<FormItem className="w-full">
								<FormLabel>{t("registry.columns.connectionType")}</FormLabel>
								<Select
									value={field.value}
									disabled={lockConnection}
									onValueChange={(value: MCPConnectionType) => {
										field.onChange(value);
										if (value === "stdio") {
											setValue("auth_type", "none");
											setValue("headers", undefined);
											setValue("oauth_config", undefined);
										}
										// needs_session_stickiness=false is rejected for
										// non-http connection types; SSE/STDIO always keep
										// a persistent connection regardless, so drop any
										// explicit false picked while http was selected.
										if (value !== "http") {
											setValue("needs_session_stickiness", undefined);
										}
										clearErrors();
									}}
								>
									<FormControl>
										<SelectTrigger className="w-full" data-testid="connection-type-select">
											<SelectValue placeholder={t("registry.form.selectConnectionType")} />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value="http" data-testid="connection-type-http">
											{t("registry.form.httpStreamable")}
										</SelectItem>
										<SelectItem value="sse" data-testid="connection-type-sse">
											{t("registry.form.sseLabel")}
										</SelectItem>
										<SelectItem value="stdio" data-testid="connection-type-stdio">
											{t("registry.form.stdioLabel")}
										</SelectItem>
									</SelectContent>
								</Select>
								{!lockConnection && <p className="text-muted-foreground text-xs">{t("registry.form.connectionImmutable")}</p>}
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			</div>

			{connectionType === "stdio" && (
				<>
					<DottedSeparator />
					<div className="space-y-4">
						<SectionHeader
							title={t("registry.form.launchCommand")}
							description={lockConnection ? t("registry.form.launchCommandLocked") : t("registry.form.launchCommandOpen")}
						/>
						<div className="space-y-4 rounded-md border p-4">
							<StdioRuntimeNotice />

							{/* STDIO Command */}
							<FormField
								control={control}
								name="stdio_config.command"
								render={({ field }) => (
									<FormItem>
										<FormLabel>{t("common.command")}</FormLabel>
										<FormControl>
											<Input
												{...field}
												value={field.value ?? ""}
												disabled={lockConnection}
												onChange={(e) => {
													field.onChange(e);
													clearErrors("stdio_config.command");
												}}
												placeholder={t("registry.form.commandPlaceholder")}
												data-testid="stdio-command-input"
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							{/* Args (local state) */}
							<div className="space-y-2">
								<Label htmlFor="stdio-args-input">{t("registry.form.argsComma")}</Label>
								<Input
									id="stdio-args-input"
									value={satellites.argsText}
									disabled={lockConnection}
									onChange={(e) => satellites.setArgsText(e.target.value)}
									placeholder={t("registry.form.argsPlaceholder")}
									data-testid="stdio-args-input"
								/>
							</div>

							{/* Envs (local state) */}
							<div className="space-y-2" role="group" aria-labelledby="stdio-envs-label">
								<div className="flex items-center gap-2">
									<Label id="stdio-envs-label">{t("registry.form.envVars")}</Label>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Info className="text-muted-foreground h-4 w-4 cursor-help" />
											</TooltipTrigger>
											<TooltipContent className="max-w-xs">
												<p>{t("registry.form.envVarsHelp")}</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<HeadersTable
									value={satellites.envVars}
									onChange={satellites.setEnvVars}
									fixedKeys={stdioEnvKeys}
									keyPlaceholder="API_KEY"
									valuePlaceholder={t("registry.form.envValuePlaceholder")}
									label=""
								/>
							</div>
						</div>
					</div>
				</>
			)}
		</>
	);
}
// Re-exported so the library sheets can build the same section scaffolding
// without reaching past this module into the individual field fragments.
export { SectionHeader };