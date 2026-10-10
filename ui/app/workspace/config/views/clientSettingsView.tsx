import PageTitle from "@/components/pageTitle";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getErrorMessage, useGetCoreConfigQuery, useGetDroppedRequestsQuery, useUpdateCoreConfigMutation } from "@/lib/store";
import { CoreConfig, DefaultCoreConfig, DefaultGlobalHeaderFilterConfig, GlobalHeaderFilterConfig } from "@/lib/types/config";
import { cn } from "@/lib/utils";
import { Info, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import UserAgentMappingsView from "./userAgentMappingsView";
// Security headers that cannot be configured in allowlist/denylist
// These headers are always blocked for security reasons regardless of configuration
const SECURITY_HEADERS = [
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
	"connection",
	"transfer-encoding",
	"x-api-key",
	"x-goog-api-key",
	"x-bf-api-key",
	"x-bf-vk",
];
// Helper to check if a header is a security header
function isSecurityHeader(header: string): boolean {
	const h = header.toLowerCase().trim();
	// Wildcard patterns are not literal security headers
	if (h.includes("*")) return false;
	return SECURITY_HEADERS.includes(h);
}
// Helper to compare header filter configs
function headerFilterConfigEqual(a?: GlobalHeaderFilterConfig, b?: GlobalHeaderFilterConfig): boolean {
	const aAllowlist = a?.allowlist || [];
	const bAllowlist = b?.allowlist || [];
	const aDenylist = a?.denylist || [];
	const bDenylist = b?.denylist || [];
	if (aAllowlist.length !== bAllowlist.length || aDenylist.length !== bDenylist.length) {
		return false;
	}
	return aAllowlist.every((v, i) => v === bAllowlist[i]) && aDenylist.every((v, i) => v === bDenylist[i]);
}
export default function ClientSettingsView() {
	const { t } = useTranslation("config");
	const [droppedRequests, setDroppedRequests] = useState<number>(0);
	const { data: droppedRequestsData } = useGetDroppedRequestsQuery();
	const { data: bifrostConfig, isLoading: isCoreConfigLoading } = useGetCoreConfigQuery({
		fromDB: true,
	});
	const config = bifrostConfig?.client_config;
	const [updateCoreConfig, { isLoading: isSavingCoreConfig }] = useUpdateCoreConfigMutation();
	const [localConfig, setLocalConfig] = useState<CoreConfig>(DefaultCoreConfig);
	const isQueriesLoading = isCoreConfigLoading;
	const isLoading = isSavingCoreConfig;
	useEffect(() => {
		if (droppedRequestsData) {
			setDroppedRequests(droppedRequestsData.dropped_requests);
		}
	}, [droppedRequestsData]);
	useEffect(() => {
		if (config) {
			setLocalConfig({
				...config,
				header_filter_config: config.header_filter_config || DefaultGlobalHeaderFilterConfig,
			});
		}
	}, [config]);
	const hasCoreConfigChanges = useMemo(() => {
		if (!config) return false;
		return (
			localConfig.drop_excess_requests !== config.drop_excess_requests ||
			localConfig.disable_db_pings_in_health !== config.disable_db_pings_in_health ||
			localConfig.dump_errors_in_console_logs !== config.dump_errors_in_console_logs ||
			localConfig.async_job_result_ttl !== config.async_job_result_ttl ||
			!headerFilterConfigEqual(localConfig.header_filter_config, config.header_filter_config)
		);
	}, [config, localConfig]);
	const hasChanges = hasCoreConfigChanges;
	// Detect security headers in allowlist/denylist
	const invalidSecurityHeaders = useMemo(() => {
		const allowlist = localConfig.header_filter_config?.allowlist || [];
		const denylist = localConfig.header_filter_config?.denylist || [];
		const invalidInAllowlist = allowlist.filter((h) => h && isSecurityHeader(h));
		const invalidInDenylist = denylist.filter((h) => h && isSecurityHeader(h));
		return [...new Set([...invalidInAllowlist, ...invalidInDenylist])];
	}, [localConfig.header_filter_config]);
	const hasSecurityHeaderError = invalidSecurityHeaders.length > 0;
	const handleConfigChange = useCallback((field: keyof CoreConfig, value: boolean | number | string[] | GlobalHeaderFilterConfig) => {
		setLocalConfig((prev) => ({ ...prev, [field]: value }));
	}, []);
	const handleSave = useCallback(async () => {
		// Defense in depth - don't save if security headers are present
		if (hasSecurityHeaderError) {
			return;
		}
		let coreConfigSaved = false;
		// Save core config if changed
		if (hasCoreConfigChanges) {
			if (!bifrostConfig) {
				toast.error(t("configNotLoadedRefresh"));
				return;
			}
			// Clean up empty strings from header filter config
			const cleanedConfig = {
				...localConfig,
				header_filter_config: {
					allowlist: (localConfig.header_filter_config?.allowlist || []).filter((h) => h && h.trim().length > 0),
					denylist: (localConfig.header_filter_config?.denylist || []).filter((h) => h && h.trim().length > 0),
				},
			};
			try {
				await updateCoreConfig({
					...bifrostConfig!,
					client_config: cleanedConfig,
				}).unwrap();
				coreConfigSaved = true;
			} catch (error) {
				toast.error(
					t("clientSettings.toastSaveClientFailed", {
						error: getErrorMessage(error),
					}),
				);
			}
		}
		if (coreConfigSaved) {
			{
				toast.success(t("clientSettings.toastSaved"));
			}
		}
	}, [bifrostConfig, hasSecurityHeaderError, hasCoreConfigChanges, localConfig, t, updateCoreConfig]);
	// Header filter list handlers
	const handleAddAllowlistHeader = useCallback(() => {
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				allowlist: [...(prev.header_filter_config?.allowlist || []), ""],
			},
		}));
	}, []);
	const handleRemoveAllowlistHeader = useCallback((index: number) => {
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				allowlist: (prev.header_filter_config?.allowlist || []).filter((_, i) => i !== index),
			},
		}));
	}, []);
	const handleAllowlistChange = useCallback((index: number, value: string) => {
		const lowerValue = value.toLowerCase();
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				allowlist: (prev.header_filter_config?.allowlist || []).map((h, i) => (i === index ? lowerValue : h)),
			},
		}));
	}, []);
	const handleAddDenylistHeader = useCallback(() => {
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				denylist: [...(prev.header_filter_config?.denylist || []), ""],
			},
		}));
	}, []);
	const handleRemoveDenylistHeader = useCallback((index: number) => {
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				denylist: (prev.header_filter_config?.denylist || []).filter((_, i) => i !== index),
			},
		}));
	}, []);
	const handleDenylistChange = useCallback((index: number, value: string) => {
		const lowerValue = value.toLowerCase();
		setLocalConfig((prev) => ({
			...prev,
			header_filter_config: {
				...prev.header_filter_config,
				denylist: (prev.header_filter_config?.denylist || []).map((h, i) => (i === index ? lowerValue : h)),
			},
		}));
	}, []);
	return (
		<div className="mx-auto w-full max-w-4xl space-y-6">
			<PageTitle title={t("clientSettings.title")}>{t("clientSettings.description")}</PageTitle>

			<div className="space-y-4">
				{/* Drop Excess Requests */}
				<div className="flex items-center justify-between space-x-2">
					<div className="space-y-0.5">
						<label htmlFor="drop-excess-requests" className="text-sm font-medium">
							{t("clientSettings.dropExcessRequests")}
						</label>
						<p className="text-muted-foreground text-sm">
							{t("clientSettings.dropExcessRequestsHelp")}{" "}
							{localConfig.drop_excess_requests && droppedRequests > 0 ? (
								<span>
									{t("clientSettings.droppedRequests", {
										count: droppedRequests,
									})}
								</span>
							) : (
								<></>
							)}
						</p>
					</div>
					<Switch
						id="drop-excess-requests"
						size="md"
						checked={localConfig.drop_excess_requests}
						onCheckedChange={(checked) => handleConfigChange("drop_excess_requests", checked)}
					/>
				</div>

				{/* Disable DB Pings in Health */}
				<div className="flex items-center justify-between space-x-2">
					<div className="space-y-0.5">
						<label htmlFor="disable-db-pings-in-health" className="text-sm font-medium">
							{t("clientSettings.disableDbPings")}
						</label>
						<p className="text-muted-foreground text-sm">{t("clientSettings.disableDbPingsHelp")}</p>
					</div>
					<Switch
						id="disable-db-pings-in-health"
						size="md"
						checked={localConfig.disable_db_pings_in_health}
						onCheckedChange={(checked) => handleConfigChange("disable_db_pings_in_health", checked)}
					/>
				</div>

				{/* Dump Errors in Console Logs */}
				<div className="flex items-center justify-between space-x-2">
					<div className="space-y-0.5">
						<label htmlFor="dump-errors-in-console-logs" className="text-sm font-medium">
							{t("clientSettings.dumpErrors")}
						</label>
						<p className="text-muted-foreground text-sm">{t("clientSettings.dumpErrorsHelp")}</p>
					</div>
					<Switch
						id="dump-errors-in-console-logs"
						data-testid="client-settings-dump-errors-switch"
						size="md"
						checked={localConfig.dump_errors_in_console_logs}
						onCheckedChange={(checked) => handleConfigChange("dump_errors_in_console_logs", checked)}
					/>
				</div>
				{/* Async Job Result TTL */}
				<div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-0.5">
						<label htmlFor="async-job-result-ttl" className="text-sm font-medium">
							{t("clientSettings.asyncJobTtl")}
						</label>
						<p className="text-muted-foreground text-sm">{t("clientSettings.asyncJobTtlHelp")}</p>
					</div>
					<Input
						id="async-job-result-ttl"
						type="number"
						min={1}
						className="w-32 shrink-0"
						value={localConfig.async_job_result_ttl}
						onChange={(e) => handleConfigChange("async_job_result_ttl", parseInt(e.target.value) || 0)}
						data-testid="client-settings-async-job-result-ttl-input"
					/>
				</div>
			</div>

			<UserAgentMappingsView disabled={isLoading} />

			{/* Header Filter Section */}
			<div className="space-y-4">
				<div>
					<h3 className="text-lg font-semibold tracking-tight">{t("clientSettings.headerForwarding")}</h3>
					<p className="text-muted-foreground text-sm">{t("clientSettings.headerForwardingHelp")}</p>
				</div>

				<Accordion type="multiple" className="w-full rounded-sm border px-4">
					<AccordionItem value="about-extra-headers">
						<AccordionTrigger>
							<span className="flex items-center gap-2">
								<Info className="h-4 w-4" />
								{t("clientSettings.aboutHeaderForwarding")}
							</span>
						</AccordionTrigger>
						<AccordionContent className="space-y-3">
							<div>
								<p className="mb-2 font-medium">{t("clientSettings.twoWays")}</p>
								<ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.prefixedHeaders"
											components={{
												span0: <span className="font-medium" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code2: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code3: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.directHeaders"
											components={{
												span0: <span className="font-medium" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
								</ul>
							</div>
							<div>
								<p className="mb-2 font-medium">{t("clientSettings.howListsWork")}</p>
								<ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.emptyAllowlist"
											components={{
												span0: <span className="font-medium" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
									<li>
										<Trans t={t} i18nKey="clientSettings.configuredAllowlist" components={{ span0: <span className="font-medium" /> }} />
									</li>
									<li>
										<Trans t={t} i18nKey="clientSettings.denylistRules" components={{ span0: <span className="font-medium" /> }} />
									</li>
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.wildcardRules"
											components={{
												span0: <span className="font-medium" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code2: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code3: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code4: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
								</ul>
							</div>
							<div>
								<p className="mb-2 font-medium">{t("clientSettings.important")}</p>
								<ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.headerNames"
											components={{
												span0: <span className="font-medium" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
									<li>
										<Trans
											t={t}
											i18nKey="clientSettings.allowlistExample"
											components={{
												code0: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code1: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
												code2: <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs" />,
											}}
										/>
									</li>
								</ul>
							</div>
						</AccordionContent>
					</AccordionItem>

					<AccordionItem value="security-note">
						<AccordionTrigger>
							<span className="flex items-center gap-2">
								<Info className="h-4 w-4" />
								{t("clientSettings.securityNote")}
							</span>
						</AccordionTrigger>
						<AccordionContent>
							<p className="text-sm">{t("clientSettings.securityNoteBody")}</p>
							<p className="text-muted-foreground mt-1 font-mono text-xs">
								proxy-authorization, cookie, host, content-length, connection, transfer-encoding, x-api-key, x-goog-api-key, x-bf-api-key,
								x-bf-vk
							</p>
						</AccordionContent>
					</AccordionItem>
				</Accordion>

				{/* Allowlist Section */}
				<div className="space-y-3">
					<div className="space-y-1">
						<h4 className="text-sm font-medium">{t("clientSettings.allowlist")}</h4>
						<p className="text-muted-foreground text-xs">
							<Trans
								t={t}
								i18nKey="clientSettings.allowlistHelp"
								components={{
									code0: <code className="bg-muted rounded px-1 font-mono" />,
								}}
							/>
						</p>
					</div>

					<div className="space-y-2">
						{(localConfig.header_filter_config?.allowlist || []).map((header, index) => (
							<div key={index} className="flex items-center gap-2">
								<Input
									placeholder={t("clientSettings.allowlistPlaceholder")}
									data-testid="header-filter-allowlist-input"
									className={cn(
										"font-mono lowercase",
										isSecurityHeader(header) &&
											"border-destructive focus:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/50",
									)}
									value={header}
									onChange={(e) => handleAllowlistChange(index, e.target.value)}
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => handleRemoveAllowlistHeader(index)}
									className="text-muted-foreground hover:text-destructive"
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						))}
						<Button type="button" variant="outline" size="sm" onClick={handleAddAllowlistHeader}>
							<Plus className="mr-2 h-4 w-4" />
							{t("addHeader")}
						</Button>
					</div>
				</div>

				{/* Denylist Section */}
				<div className="space-y-3">
					<div className="space-y-1">
						<h4 className="text-sm font-medium">{t("clientSettings.denylist")}</h4>
						<p className="text-muted-foreground text-xs">
							<Trans
								t={t}
								i18nKey="clientSettings.denylistHelp"
								components={{
									code0: <code className="bg-muted rounded px-1 font-mono" />,
								}}
							/>
						</p>
					</div>

					<div className="space-y-2">
						{(localConfig.header_filter_config?.denylist || []).map((header, index) => (
							<div key={index} className="flex items-center gap-2">
								<Input
									placeholder={t("clientSettings.denylistPlaceholder")}
									data-testid="header-filter-denylist-input"
									className={cn(
										"font-mono lowercase",
										isSecurityHeader(header) &&
											"border-destructive focus:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/50",
									)}
									value={header}
									onChange={(e) => handleDenylistChange(index, e.target.value)}
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									onClick={() => handleRemoveDenylistHeader(index)}
									className="text-muted-foreground hover:text-destructive"
								>
									<X className="h-4 w-4" />
								</Button>
							</div>
						))}
						<Button type="button" variant="outline" size="sm" onClick={handleAddDenylistHeader}>
							<Plus className="mr-2 h-4 w-4" />
							{t("addHeader")}
						</Button>
					</div>
				</div>
			</div>

			<div className="bg-card sticky bottom-0 flex justify-end py-2">
				{hasSecurityHeaderError ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span>
								<Button disabled>{isLoading ? t("saving") : t("saveChanges")}</Button>
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{t("clientSettings.removeSecurityHeaders", {
								count: invalidSecurityHeaders.length,
								headers: invalidSecurityHeaders.join(", "),
							})}
						</TooltipContent>
					</Tooltip>
				) : (
					<Button onClick={handleSave} disabled={!hasChanges || isLoading || isQueriesLoading}>
						{isLoading ? t("saving") : t("saveChanges")}
					</Button>
				)}
			</div>
		</div>
	);
}