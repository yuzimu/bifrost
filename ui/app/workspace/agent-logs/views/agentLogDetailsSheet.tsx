import { formatLatency } from "@/app/workspace/dashboard/utils/chartUtils";
import BlockHeader from "@/app/workspace/logs/views/blockHeader";
import LogEntryDetailsView from "@/app/workspace/logs/views/logEntryDetailsView";
import PluginLogsView from "@/app/workspace/logs/views/pluginLogsView";
import { SheetNavigationButtons } from "@/components/sheetNavigationButtons";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alertDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/codeEditor";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdownMenu";
import { DottedSeparator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useSheetNavigation } from "@/hooks/useSheetNavigation";
import { useGetAgentLogOperationByIdQuery } from "@/lib/store/apis/agentLogsApi";
import type { AgentLogDetail, AgentLogFilters, AgentLogStatus, AgentLogSummary } from "@/lib/types/agentLogs";
import { OverheadBreakdown } from "@/components/logs/overheadBreakdown";
import { cn } from "@/lib/utils";
import { downloadAsJson } from "@/lib/utils/browser-download";
import { Link } from "@tanstack/react-router";
import { format, isValid } from "date-fns";
import { ChevronDown, Download, Loader2, MoreVertical, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";
import { dateFnsLocale } from "@/lib/i18n/dateLocale";
const t = i18n.getFixedT(null, "agents");
import {
	A2AConversationHistory,
	A2AOperationConversation,
	isA2AConversationOperation,
	isA2APushConversationOperation,
} from "./agentContextDetailsSheet";
import { A2APayloadView } from "./a2aPayloadView";
import { CorrelatedLogsContent, useCorrelatedLogCounts } from "./correlatedLogs";
interface AgentLogDetailSheetProps {
	log: AgentLogSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Narrow the page to operations matching one stored field. */
	onFilter?: (filters: FilterTarget) => void;
	handleDelete?: (log: AgentLogSummary) => Promise<void>;
	onViewContext?: (contextId: string, logId: string) => void;
	onNavigate?: (direction: "prev" | "next") => void;
	hasPrev?: boolean;
	hasNext?: boolean;
}
const pillStyles: Record<AgentLogStatus, string> = {
	success: "border-chart-success/30 bg-chart-success/10 text-chart-success-ink",
	error: "border-chart-error/30 bg-chart-error/10 text-chart-error-ink",
	processing: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900",
};
const pillDotStyles: Record<AgentLogStatus, string> = {
	success: "bg-chart-success",
	error: "bg-chart-error",
	processing: "bg-blue-500",
};
function StatusPill({ status }: { status: AgentLogStatus }) {
	const { t } = useTranslation("agents");
	const tone: AgentLogStatus = status in pillStyles ? status : "processing";
	return (
		<span
			className={cn("inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase", pillStyles[tone])}
		>
			<span className={cn("h-1.5 w-1.5 rounded-sm", pillDotStyles[tone])} />
			{t(status)}
		</span>
	);
}
type FilterTarget = Partial<Omit<AgentLogFilters, "period" | "start_time" | "end_time">>;
/** Values filter on left-click and copy on right-click. */
function InteractiveValue({
	value,
	label,
	filter,
	testId,
	className,
	onFilter,
}: {
	value: string;
	label: string;
	filter?: FilterTarget;
	onFilter?: (filters: FilterTarget) => void;
	testId?: string;
	className?: string;
}) {
	const { t } = useTranslation("agents");
	const { copy } = useCopyToClipboard({ successMessage: t("copied") });
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						if (filter) onFilter?.(filter);
					}}
					onContextMenu={(event) => {
						event.preventDefault();
						event.stopPropagation();
						copy(value);
					}}
					className={cn(
						"focus-visible:ring-ring min-w-0 max-w-full truncate text-left underline-offset-2 transition hover:underline focus-visible:ring-2 focus-visible:outline-none",
						filter ? "cursor-pointer" : "cursor-context-menu",
						className,
					)}
					aria-label={filter ? t("filterBy", { label }) : label}
					data-testid={testId}
				>
					{value}
				</button>
			</TooltipTrigger>
			<TooltipContent>{filter ? t("filterCopyHint") : t("copyHint")}</TooltipContent>
		</Tooltip>
	);
}
function IdRow({
	label,
	value,
	filter,
	onFilter,
	testId,
}: {
	label: string;
	value?: string;
	filter?: FilterTarget;
	onFilter?: (filters: FilterTarget) => void;
	testId?: string;
}) {
	if (!value) return null;
	return (
		<div className="mt-1 flex items-center gap-2 first:mt-0">
			<div className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">{label}</div>
			<InteractiveValue
				value={value}
				label={label}
				filter={filter}
				onFilter={onFilter}
				testId={testId}
				className="text-foreground font-mono text-[13px]"
			/>
		</div>
	);
}
function HeroStat({
	label,
	value,
	sub,
	mono = false,
	valueClass,
	hasRightBorder = false,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	mono?: boolean;
	valueClass?: string;
	hasRightBorder?: boolean;
}) {
	return (
		<div className={cn("border-border/70 min-w-0 border-b px-5 py-3 md:border-b-0", hasRightBorder && "md:border-r")}>
			<div className="text-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase">{label}</div>
			<div className={cn("mt-0.5 truncate text-[18px] font-semibold tabular-nums", mono && "font-mono text-[15px]", valueClass)}>
				{value}
			</div>
			{sub ? <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{sub}</div> : null}
		</div>
	);
}
// Bodies are JSON strings; the Raw JSON tab shows the record verbatim.
function PayloadBlock({ title, code }: { title: string; code: string }) {
	return (
		<div className="w-full rounded-sm border">
			<div className="border-b px-4 py-2 text-sm font-medium md:px-6">{title}</div>
			<CodeEditor
				className="z-0 w-full"
				shouldAdjustInitialHeight={true}
				maxHeight={350}
				wrap={true}
				code={code}
				lang="json"
				readonly={true}
				options={{
					scrollBeyondLastLine: false,
					collapsibleBlocks: true,
					lineNumbers: "off",
					alwaysConsumeMouseWheel: false,
				}}
			/>
		</div>
	);
}
function getPluginLogCount(pluginLogs?: string): number {
	if (!pluginLogs) return 0;
	try {
		const parsed: unknown = JSON.parse(pluginLogs);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
		return Object.values(parsed).reduce<number>((count, entries) => count + (Array.isArray(entries) ? entries.length : 0), 0);
	} catch {
		return 0;
	}
}
/** 翻译事件及已知状态标签，未知协议值保持原样。 */
function eventLabel(row: AgentLogSummary): string {
	if (row.event_type === "artifact_update") return t("artifactUpdated");
	const stateKey = `taskStates.${row.task_state?.replace(/^TASK_STATE_/, "").toLowerCase()}`;
	const state = i18n.exists(stateKey, { ns: "agents" }) ? t(stateKey) : row.task_state;
	if (row.event_type === "status_update" && state) return state;
	if (row.event_type === "task" && state) return `${t("task")} ${state}`;
	if (row.event_type === "message") return t("messageReceived");
	return row.event_type || t("event");
}
/** 根据事件类型提供本地化说明。 */
function eventExplanation(row: AgentLogSummary): string {
	if (row.event_type === "artifact_update") return t("artifactUpdatedDescription");
	if (row.event_type === "status_update") return t("statusUpdatedDescription");
	if (row.event_type === "task") return t("taskSnapshotDescription");
	if (row.event_type === "message") return t("messageReceivedDescription");
	return t("protocolEventDescription");
}
function EventDetailValue({
	label,
	value,
	filter,
	onFilter,
}: {
	label: string;
	value?: string | number;
	filter?: FilterTarget;
	onFilter?: (filters: FilterTarget) => void;
}) {
	if (value === undefined || value === "") return null;
	const rendered = String(value);
	return (
		<div className="min-w-0 space-y-1">
			<div className="text-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase">{label}</div>
			<InteractiveValue
				value={rendered}
				label={label}
				filter={filter}
				onFilter={onFilter}
				className="text-foreground block max-w-full font-mono text-xs"
			/>
		</div>
	);
}
function FormattedEventDetail({ detail, onFilter }: { detail: AgentLogDetail; onFilter?: (filters: FilterTarget) => void }) {
	const { t } = useTranslation("agents");
	const timestamp = detail.timestamp ? new Date(detail.timestamp) : null;
	const fields: [string, string | number | undefined, FilterTarget | undefined][] = [
		[t("eventId"), detail.id, { search: detail.id }],
		[t("sequence"), detail.event_sequence, undefined],
		[t("eventType"), detail.event_type, undefined],
		[t("taskState"), detail.task_state, detail.task_state ? { task_state: [detail.task_state] } : undefined],
		[t("taskId"), detail.task_id, detail.task_id ? { task_id: detail.task_id } : undefined],
		[t("contextId"), detail.context_id, detail.context_id ? { context_id: detail.context_id } : undefined],
		[t("messageId"), detail.message_id, detail.message_id ? { search: detail.message_id } : undefined],
		[t("artifactId"), detail.artifact_id, detail.artifact_id ? { search: detail.artifact_id } : undefined],
		[t("requestId"), detail.request_id, { request_id: detail.request_id }],
		[t("traceId"), detail.trace_id, detail.trace_id ? { trace_id: detail.trace_id } : undefined],
		[t("agent"), detail.agent_name, { agent_name: [detail.agent_name] }],
		[t("operation"), detail.operation, { operation: [detail.operation] }],
		[t("status"), detail.status, { status: [detail.status] }],
		[t("contentType"), detail.content_type, undefined],
		[t("virtualKeyId"), detail.virtual_key_id, detail.virtual_key_id ? { virtual_key_id: [detail.virtual_key_id] } : undefined],
		[t("pushConfigId"), detail.push_config_id, detail.push_config_id ? { push_config_id: detail.push_config_id } : undefined],
		[t("deliveryId"), detail.delivery_id, detail.delivery_id ? { delivery_id: detail.delivery_id } : undefined],
		[t("attemptId"), detail.attempt_id, detail.attempt_id ? { attempt_id: detail.attempt_id } : undefined],
	];
	return (
		<div className="space-y-3">
			<details className="group rounded-sm border">
				<summary className="hover:bg-muted/30 flex cursor-pointer items-center justify-between px-3 py-2 text-sm transition">
					<span className="font-medium">{t("eventDetails")}</span>
					<span className="text-muted-foreground flex items-center gap-2 text-xs">
						{t("eventMetadata")}
						<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
					</span>
				</summary>
				<div className="grid grid-cols-1 gap-x-5 gap-y-3 border-t p-3 sm:grid-cols-2">
					<EventDetailValue
						label={t("timestamp")}
						value={timestamp && isValid(timestamp) ? format(timestamp, "yyyy-MM-dd HH:mm:ss.SSS") : detail.timestamp}
					/>
					{fields.map(([label, value, filter]) => (
						<EventDetailValue key={label} label={label} value={value} filter={filter} onFilter={onFilter} />
					))}
				</div>
			</details>
			<A2APayloadView eventBody={detail.event_body} />
		</div>
	);
}
function rawEventRecord(detail: AgentLogDetail): string {
	if (!detail.event_body) return JSON.stringify(detail, null, 2);
	try {
		return JSON.stringify({ ...detail, event_body: JSON.parse(detail.event_body) }, null, 2);
	} catch {
		return JSON.stringify(detail, null, 2);
	}
}
/** 展示日志详情和事件，保留导航、导出和删除行为。 */
export function AgentLogDetailSheet({
	log,
	open,
	onOpenChange,
	onFilter,
	handleDelete,
	onViewContext,
	onNavigate,
	hasPrev = false,
	hasNext = false,
}: AgentLogDetailSheetProps) {
	const { t } = useTranslation("agents");
	const {
		data: fullLog,
		isLoading,
		isError,
	} = useGetAgentLogOperationByIdQuery(log?.id ?? "", {
		skip: !open || !log?.id,
	});
	const correlatedRows = useMemo(() => {
		const rows = fullLog?.events ?? [];
		return [...rows].sort((a, b) => {
			if (a.event_sequence != null && b.event_sequence != null) return a.event_sequence - b.event_sequence;
			return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
		});
	}, [fullLog?.events]);
	const totalCorrelatedEvents = correlatedRows.length;
	const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
	const [rawEventIds, setRawEventIds] = useState<Set<string>>(new Set());
	useEffect(() => {
		setExpandedEventIds(new Set());
		setRawEventIds(new Set());
	}, [log?.id]);
	const toggleEvent = (row: AgentLogSummary) => {
		setExpandedEventIds((current) => {
			const next = new Set(current);
			if (next.has(row.id)) next.delete(row.id);
			else next.add(row.id);
			return next;
		});
	};
	const toggleEventRaw = (eventID: string) => {
		setRawEventIds((current) => {
			const next = new Set(current);
			if (next.has(eventID)) next.delete(eventID);
			else next.add(eventID);
			return next;
		});
	};
	// Keyboard navigation: arrow up/down to navigate between operations
	const { prev: prevKeys, next: nextKeys } = useSheetNavigation({
		enabled: open,
		hasPrev,
		hasNext,
		onNavigate: (direction) => onNavigate?.(direction),
	});
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [activeTab, setActiveTab] = useState({ correlationKey: "", value: "" });
	const isSelectedOperation = Boolean(log && fullLog && (fullLog.id === log.id || fullLog.request_id === log.request_id));
	const isFullDataReady = Boolean(log) && (isError || (isSelectedOperation && !isLoading));
	const displayLog = log ? (isFullDataReady && fullLog ? fullLog : log) : null;
	const isCorrelatedConversation = displayLog ? isA2AConversationOperation(displayLog.operation) : false;
	const logCorrelation = useMemo(
		() => (isCorrelatedConversation && displayLog?.task_id ? { agent_correlation_id: displayLog.task_id } : null),
		[displayLog?.task_id, isCorrelatedConversation],
	);
	const correlationKey = logCorrelation?.agent_correlation_id ?? "";
	const { llmCount, mcpCount } = useCorrelatedLogCounts(logCorrelation, open);
	if (!log || !displayLog) return null;
	if (!isFullDataReady) {
		return (
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent className="border-secondary flex w-full flex-col gap-4 overflow-x-hidden border p-4 sm:max-w-[60%] md:p-8">
					<div className="flex h-full items-center justify-center">
						<SheetTitle className="sr-only">{t("loadingLogDetails")}</SheetTitle>
						<Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
					</div>
				</SheetContent>
			</Sheet>
		);
	}
	const detail = isFullDataReady && isSelectedOperation ? fullLog : undefined;
	const timestampDate = displayLog.timestamp ? new Date(displayLog.timestamp) : null;
	const hasValidTimestamp = Boolean(timestampDate && isValid(timestampDate));
	const hasValidLatency = displayLog.latency != null && !isNaN(displayLog.latency);
	const endTimestamp = hasValidTimestamp && hasValidLatency ? new Date(timestampDate!.getTime() + displayLog.latency!) : null;
	// Only request-kind rows carry the latency breakdown; events have no timings beyond their timestamp.
	const hasTimings =
		hasValidLatency ||
		displayLog.upstream_latency != null ||
		displayLog.overhead_latency != null ||
		(displayLog.overhead_breakdown?.length ?? 0) > 0;
	const pluginLogCount = getPluginLogCount(detail?.plugin_logs);
	const isConversationOperation = isA2AConversationOperation(displayLog.operation);
	const isPushConversationOperation = isA2APushConversationOperation(displayLog.operation);
	const conversationLog = (isConversationOperation || isPushConversationOperation) && detail ? detail : null;
	const hasConversation = Boolean(
		conversationLog && (conversationLog.request_body || conversationLog.response_body || conversationLog.error_details),
	);
	const hasPayload = Boolean(detail && (detail.request_body || detail.response_body || detail.error_details));
	const defaultTab = hasConversation
		? "conversation"
		: hasPayload
			? "payload"
			: correlatedRows.length > 0
				? "events"
				: pluginLogCount > 0
					? "plugins"
					: "raw";
	const isPushRelated = Boolean(displayLog.push_config_id || displayLog.delivery_id || displayLog.attempt_id);
	const governanceLinks = (
		[
			[
				t("team"),
				t("teams"),
				"/workspace/governance/teams",
				"selected_team",
				displayLog.team_name,
				displayLog.team_id,
				displayLog.team_names,
				displayLog.team_ids,
			],
			[
				t("customer"),
				t("customers"),
				"/workspace/governance/customers",
				"selected_customer",
				displayLog.customer_name,
				displayLog.customer_id,
				displayLog.customer_names,
				displayLog.customer_ids,
			],
		] as const
	)
		.map(([label, pluralLabel, route, searchKey, name, id, names, ids]) => {
			const items = ids?.length
				? ids.map((itemID, index) => ({ id: itemID, name: names?.[index] || itemID }))
				: id
					? [{ id, name: name || id }]
					: [];
			return { label, pluralLabel, route, searchKey, items };
		})
		.filter(({ items }) => items.length > 0);
	const diagnosticSections = (
		[
			{
				title: t("recordIdentifiers"),
				fields: [
					[t("recordId"), displayLog.id, { search: displayLog.id }],
					[t("requestId"), displayLog.request_id, { request_id: displayLog.request_id }],
					[t("traceId"), displayLog.trace_id, displayLog.trace_id ? { trace_id: displayLog.trace_id } : undefined],
				],
			},
			{
				title: t("protocolCorrelation"),
				fields: [
					[t("taskId"), displayLog.task_id, displayLog.task_id ? { task_id: displayLog.task_id } : undefined],
					[t("contextId"), displayLog.context_id, displayLog.context_id ? { context_id: displayLog.context_id } : undefined],
					[t("messageId"), displayLog.message_id, displayLog.message_id ? { search: displayLog.message_id } : undefined],
					[
						t("requestMessageId"),
						displayLog.request_message_id,
						displayLog.request_message_id ? { search: displayLog.request_message_id } : undefined,
					],
					[
						t("responseMessageId"),
						displayLog.response_message_id,
						displayLog.response_message_id ? { search: displayLog.response_message_id } : undefined,
					],
					[t("artifactId"), displayLog.artifact_id, displayLog.artifact_id ? { search: displayLog.artifact_id } : undefined],
					[t("eventSequence"), displayLog.event_sequence, undefined],
					[t("eventType"), displayLog.event_type, undefined],
					[t("taskState"), displayLog.task_state, displayLog.task_state ? { task_state: [displayLog.task_state] } : undefined],
				],
			},
			{
				title: t("pushCorrelation"),
				fields: [
					[
						t("pushConfigId"),
						displayLog.push_config_id,
						displayLog.push_config_id ? { push_config_id: displayLog.push_config_id } : undefined,
					],
					[t("deliveryId"), displayLog.delivery_id, displayLog.delivery_id ? { delivery_id: displayLog.delivery_id } : undefined],
					[t("attemptId"), displayLog.attempt_id, displayLog.attempt_id ? { attempt_id: displayLog.attempt_id } : undefined],
				],
			},
		] satisfies {
			title: string;
			fields: [string, string | number | undefined, FilterTarget | undefined][];
		}[]
	).map((section) => ({
		...section,
		fields: section.fields.filter(([, value]) => value !== undefined && value !== ""),
	}));
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="border-secondary flex w-full flex-col gap-4 overflow-x-hidden border p-4 sm:max-w-[60%] md:p-8">
				<SheetHeader className="flex flex-row items-center px-0" headerClassName="mb-0">
					<div className="flex w-full items-center gap-2">
						<SheetNavigationButtons
							hasPrev={hasPrev}
							hasNext={hasNext}
							onNavigate={(dir) => onNavigate?.(dir)}
							prevKeys={prevKeys}
							nextKeys={nextKeys}
							entityLabel={t("operation")}
						/>
						<SheetTitle className="flex w-fit items-center gap-2 font-medium">
							<span className="text-foreground text-sm font-medium">{t("agentOperation")}</span>
						</SheetTitle>
						{displayLog.context_id && onViewContext ? (
							<Button
								variant="outline"
								size="sm"
								data-testid="a2alogdetails-view-context"
								onClick={() => onViewContext(displayLog.context_id!, displayLog.id)}
							>
								{t("viewSession")}
							</Button>
						) : null}
					</div>
					<AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
						<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" className="size-8" type="button" aria-label={t("logActions")}>
									<MoreVertical className="h-3 w-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									data-testid="a2alogdetails-export-log-json"
									onSelect={(e) => {
										e.preventDefault();
										downloadAsJson(displayLog, `agent-log-${displayLog.id ?? "export"}.json`);
										setDropdownOpen(false);
									}}
								>
									<Download className="h-4 w-4" />
									{t("exportJson")}
								</DropdownMenuItem>
								{handleDelete ? (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											variant="destructive"
											onSelect={(e) => {
												e.preventDefault();
												setDeleteDialogOpen(true);
												setDropdownOpen(false);
											}}
										>
											<Trash2 className="h-4 w-4" />
											{t("deleteLog")}
										</DropdownMenuItem>
									</>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>{t("deleteLogConfirm")}</AlertDialogTitle>
								<AlertDialogDescription>{t("deleteLogDescription")}</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
								<AlertDialogAction
									onClick={async (e) => {
										e.preventDefault();
										if (!handleDelete) return;
										try {
											await handleDelete(displayLog);
											setDeleteDialogOpen(false);
											onOpenChange(false);
										} catch (err) {
											const errorMessage = err instanceof Error ? err.message : t("deleteLogFailed");
											toast.error(errorMessage);
											// Keep dialog open on error so user can see the error and retry
										}
									}}
								>
									{t("delete")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</SheetHeader>

				<div className="border-border rounded-sm border">
					<div className="flex items-start justify-between gap-6 px-5 pt-5 pb-4">
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<StatusPill status={displayLog.status} />
								{isPushRelated && (
									<Badge variant="outline" className="text-muted-foreground rounded-sm px-2 py-0.5 font-normal">
										{t("pushNotification")}
									</Badge>
								)}
							</div>
							<div className="mt-3">
								<IdRow
									label={t("agent")}
									value={displayLog.agent_name}
									filter={{ agent_name: [displayLog.agent_name] }}
									onFilter={onFilter}
									testId="a2alogdetails-copy-agent-button"
								/>
								<IdRow
									label={t("request")}
									value={displayLog.request_id}
									filter={{ request_id: displayLog.request_id }}
									onFilter={onFilter}
									testId="a2alogdetails-copy-request-id-button"
								/>
								{displayLog.push_config_id && (
									<IdRow
										label={t("pushConfig")}
										value={displayLog.push_config_id}
										filter={{ push_config_id: displayLog.push_config_id }}
										onFilter={onFilter}
										testId="a2alogdetails-copy-push-config-id-button"
									/>
								)}
								{displayLog.task_id && (
									<div className="mt-1 flex max-w-full items-center gap-2">
										<span className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
											{t("task")}
										</span>
										<InteractiveValue
											value={displayLog.task_id}
											label={t("task")}
											filter={{ task_id: displayLog.task_id }}
											onFilter={onFilter}
											className="font-mono text-[13px]"
										/>
									</div>
								)}
								{displayLog.context_id && (
									<div className="mt-1 flex max-w-full items-center gap-2">
										<span className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
											{t("context")}
										</span>
										<InteractiveValue
											value={displayLog.context_id}
											label={t("context")}
											filter={{ context_id: displayLog.context_id }}
											onFilter={onFilter}
											className="font-mono text-[13px]"
										/>
									</div>
								)}
								{displayLog.virtual_key_id && (
									<div className="mt-1 flex items-center gap-2">
										<span className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
											{t("virtualKey")}
										</span>
										<Link
											to="/workspace/governance/virtual-keys"
											search={{ selected_vk: displayLog.virtual_key_id }}
											className="truncate font-mono text-[13px] text-blue-600 hover:underline dark:text-blue-400"
										>
											{displayLog.virtual_key_name || displayLog.virtual_key_id}
										</Link>
									</div>
								)}
							</div>
						</div>
					</div>
					<div
						className={cn(
							"border-border grid grid-cols-1 border-t sm:grid-cols-2",
							correlatedRows.length > 0 ? "md:grid-cols-5" : "md:grid-cols-4",
						)}
					>
						<HeroStat
							label={t("latency")}
							valueClass="text-primary"
							value={hasValidLatency ? formatLatency(displayLog.latency!) : "—"}
							sub={
								hasValidTimestamp
									? `${format(timestampDate!, "HH:mm:ss")} → ${endTimestamp ? format(endTimestamp, "HH:mm:ss") : "—"}`
									: undefined
							}
							hasRightBorder
						/>
						<HeroStat
							label={t("downstream")}
							value={displayLog.downstream_transport || "—"}
							valueClass="font-mono text-[15px]"
							hasRightBorder
						/>
						<HeroStat
							label={t("upstream")}
							value={displayLog.upstream_transport || "—"}
							valueClass="font-mono text-[15px]"
							hasRightBorder
						/>
						<HeroStat
							label={t("operation")}
							value={displayLog.operation || "—"}
							valueClass="whitespace-normal overflow-visible break-all font-mono text-[15px]"
							hasRightBorder
						/>
						{correlatedRows.length > 0 && <HeroStat label={t("events")} value={String(totalCorrelatedEvents)} />}
					</div>
				</div>

				<details className="group bg-card rounded-sm border" open>
					<summary className="hover:bg-muted/30 flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm transition">
						<span className="text-foreground font-medium">{t("moreDetails")}</span>
						<span className="text-muted-foreground flex items-center gap-2 text-xs">
							<span className="hidden md:inline">{hasTimings ? t("timingsIdentifiersCorrelation") : t("identifiersCorrelation")}</span>
							<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
						</span>
					</summary>
					<div className="space-y-4 border-t px-4 py-4 md:px-6">
						{hasTimings && (
							<>
								<div className="space-y-4">
									<BlockHeader title={t("timings")} />
									<div className="grid w-full grid-cols-1 items-center justify-between gap-4 md:grid-cols-3">
										{hasValidTimestamp && (
											<LogEntryDetailsView
												className="w-full"
												label={t("startTimestamp")}
												value={format(timestampDate!, "yyyy-MM-dd hh:mm:ss aa", {
													locale: dateFnsLocale(i18n.language),
												})}
											/>
										)}
										{endTimestamp && (
											<LogEntryDetailsView
												className="w-full"
												label={t("endTimestamp")}
												value={format(endTimestamp, "yyyy-MM-dd hh:mm:ss aa", {
													locale: dateFnsLocale(i18n.language),
												})}
											/>
										)}
										{hasValidLatency && (
											<LogEntryDetailsView
												className="w-full"
												label={t("latency")}
												tooltip={t("latencyDescription")}
												value={<div>{displayLog.latency!.toFixed(2)}ms</div>}
											/>
										)}
										{displayLog.upstream_latency != null && !isNaN(displayLog.upstream_latency) && (
											<LogEntryDetailsView
												className="w-full"
												label={t("upstreamLatency")}
												tooltip={t("upstreamLatencyDescription")}
												value={<div>{displayLog.upstream_latency.toFixed(2)}ms</div>}
											/>
										)}
										{displayLog.overhead_latency != null && !isNaN(displayLog.overhead_latency) && (
											<LogEntryDetailsView
												className="w-full"
												label={t("bifrostOverhead")}
												tooltip={t("bifrostOverheadDescription")}
												value={<div>{displayLog.overhead_latency.toFixed(2)}ms</div>}
											/>
										)}
									</div>
									{displayLog.overhead_breakdown && displayLog.overhead_breakdown.length > 0 ? (
										<OverheadBreakdown buckets={displayLog.overhead_breakdown} overheadMs={displayLog.overhead_latency} />
									) : null}
								</div>
								<DottedSeparator />
							</>
						)}
						<div className="space-y-4">
							<BlockHeader title={t("requestDetails")} />
							<div className="grid w-full grid-cols-1 items-start gap-4 md:grid-cols-3">
								<LogEntryDetailsView
									className="w-full"
									label={t("agent")}
									value={<span className="font-mono">{displayLog.agent_name}</span>}
								/>
								<LogEntryDetailsView
									className="w-full"
									label={t("operation")}
									value={<span className="font-mono">{displayLog.operation}</span>}
								/>
								<LogEntryDetailsView className="w-full" label={t("status")} value={t(displayLog.status)} />
								{displayLog.content_type && (
									<LogEntryDetailsView className="w-full" label={t("contentType")} value={displayLog.content_type} />
								)}
								{displayLog.virtual_key_id && (
									<LogEntryDetailsView
										className="w-full"
										label={t("virtualKey")}
										value={
											<Link
												to="/workspace/governance/virtual-keys"
												search={{ selected_vk: displayLog.virtual_key_id }}
												className="text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
											>
												{displayLog.virtual_key_name || displayLog.virtual_key_id}
											</Link>
										}
									/>
								)}
								{governanceLinks.map(({ label, pluralLabel, route, searchKey, items }) => (
									<LogEntryDetailsView
										key={label}
										className="w-full"
										label={items.length > 1 ? pluralLabel : label}
										value={
											<span className="inline-flex flex-wrap gap-x-1">
												{items.map((item, index) => (
													<Tooltip key={item.id}>
														<TooltipTrigger asChild>
															<Link
																to={route}
																search={{ [searchKey]: item.id }}
																className="text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
															>
																{item.name}
																{index < items.length - 1 ? "," : ""}
															</Link>
														</TooltipTrigger>
														<TooltipContent sideOffset={6}>{item.id}</TooltipContent>
													</Tooltip>
												))}
											</span>
										}
									/>
								))}
							</div>
						</div>
						{diagnosticSections
							.filter(({ fields }) => fields.length > 0)
							.map(({ title, fields }) => (
								<div key={title} className="space-y-4">
									<DottedSeparator />
									<BlockHeader title={title} />
									<div className="grid w-full grid-cols-1 items-start gap-4 md:grid-cols-3">
										{fields.map(([label, value, filter]) => (
											<LogEntryDetailsView
												key={label}
												className="w-full"
												label={label}
												value={
													<span className="inline-flex max-w-full items-center gap-1">
														{typeof value === "string" ? (
															<InteractiveValue
																value={value}
																label={label}
																filter={filter}
																onFilter={onFilter}
																className="font-mono text-xs"
															/>
														) : (
															<span className="truncate font-mono text-xs">{String(value)}</span>
														)}
													</span>
												}
											/>
										))}
									</div>
								</div>
							))}
					</div>
				</details>

				<Tabs
					key={`${displayLog.id}:${defaultTab}`}
					defaultValue={defaultTab}
					onValueChange={(value) => setActiveTab({ correlationKey, value })}
					className="gap-2"
				>
					<TabsList className="bg-muted/60 h-10 w-fit">
						{hasConversation && (
							<TabsTrigger value="conversation" className="px-3">
								{t("conversation")}
							</TabsTrigger>
						)}
						{!isConversationOperation && !isPushConversationOperation && hasPayload && (
							<TabsTrigger value="payload" className="px-3">
								{t("payload")}
							</TabsTrigger>
						)}
						{correlatedRows.length > 0 && (
							<TabsTrigger value="events" className="px-3">
								{t("events")}
								{correlatedRows.length > 0 ? (
									<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
										{totalCorrelatedEvents}
									</span>
								) : null}
							</TabsTrigger>
						)}
						{pluginLogCount > 0 && (
							<TabsTrigger value="plugins" className="px-3">
								{t("pluginLogs")}
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{pluginLogCount}
								</span>
							</TabsTrigger>
						)}
						{logCorrelation && llmCount > 0 ? (
							<TabsTrigger value="llm-logs" className="px-3">
								{t("llmLogs")}{" "}
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{llmCount}
								</span>
							</TabsTrigger>
						) : null}
						{logCorrelation && mcpCount > 0 ? (
							<TabsTrigger value="mcp-logs" className="px-3">
								{t("mcpLogs")}{" "}
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{mcpCount}
								</span>
							</TabsTrigger>
						) : null}
						<TabsTrigger value="raw" className="px-3">
							{t("rawJson")}
						</TabsTrigger>
					</TabsList>

					{hasConversation && conversationLog && (
						<TabsContent value="conversation" className="space-y-4 px-1 py-2">
							<A2AOperationConversation log={conversationLog} allowPushConversation={isPushConversationOperation} />
							<A2AConversationHistory responseBody={conversationLog.response_body} />
						</TabsContent>
					)}

					{!isConversationOperation && !isPushConversationOperation && hasPayload && detail && (
						<TabsContent value="payload" className="px-1 py-2">
							<A2APayloadView
								operation={detail.operation}
								status={detail.status}
								requestBody={detail.request_body}
								responseBody={detail.response_body}
								errorDetails={detail.error_details}
							/>
						</TabsContent>
					)}

					{correlatedRows.length > 0 && (
						<TabsContent value="events" className="space-y-3">
							<div className="text-muted-foreground text-sm">{t("eventsDescription")}</div>
							<div className="space-y-2">
								{correlatedRows.map((row) => {
									const rowDate = row.timestamp ? new Date(row.timestamp) : null;
									const isExpanded = expandedEventIds.has(row.id);
									const showRaw = rawEventIds.has(row.id);
									const eventDetail: AgentLogDetail = row;
									return (
										<div key={row.id} className={cn("rounded-sm border", isExpanded && "border-primary/50 bg-muted/20")}>
											<div className="hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3">
												<button
													type="button"
													onClick={() => void toggleEvent(row)}
													className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
													data-testid={`a2alogdetails-event-row-${row.id}`}
												>
													<span className="bg-muted text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[10px]">
														{row.event_sequence ?? "·"}
													</span>
													<div className="min-w-0 flex-1">
														<div className="flex flex-wrap items-center gap-2">
															<span className="text-sm font-medium capitalize">{eventLabel(row)}</span>
															{row.task_state && (
																<Badge variant="outline" className="rounded-sm text-[10px]">
																	{row.task_state}
																</Badge>
															)}
														</div>
														<div className="text-muted-foreground mt-0.5 text-xs">{eventExplanation(row)}</div>
													</div>
												</button>
												<div className="flex shrink-0 flex-col items-end gap-2">
													<span className="text-muted-foreground font-mono text-[11px] tabular-nums">
														{rowDate && isValid(rowDate) ? format(rowDate, "HH:mm:ss.SSS") : ""}
													</span>
													{isExpanded && eventDetail && (
														<Tabs
															value={showRaw ? "raw" : "formatted"}
															onValueChange={(next) => (next === "raw") !== showRaw && toggleEventRaw(row.id)}
															className="shrink-0"
														>
															<TabsList aria-label={t("eventView")} className="h-6 rounded-sm p-0.5">
																<TabsTrigger value="formatted" className="rounded-[3px] px-2 text-[11px] leading-5">
																	{t("formatted")}
																</TabsTrigger>
																<TabsTrigger value="raw" className="rounded-[3px] px-2 text-[11px] leading-5">
																	{t("rawJson")}
																</TabsTrigger>
															</TabsList>
														</Tabs>
													)}
												</div>
											</div>
											{isExpanded && (
												<div className="border-t p-3">
													{showRaw ? (
														<PayloadBlock title={t("rawEventRecord")} code={rawEventRecord(eventDetail)} />
													) : (
														<FormattedEventDetail detail={eventDetail} onFilter={onFilter} />
													)}
												</div>
											)}
										</div>
									);
								})}
							</div>
						</TabsContent>
					)}

					{logCorrelation && llmCount > 0 ? (
						<CorrelatedLogsContent
							key={`llm:${correlationKey}`}
							kind="llm"
							correlation={logCorrelation}
							active={activeTab.correlationKey === correlationKey && activeTab.value === "llm-logs"}
						/>
					) : null}
					{logCorrelation && mcpCount > 0 ? (
						<CorrelatedLogsContent
							key={`mcp:${correlationKey}`}
							kind="mcp"
							correlation={logCorrelation}
							active={activeTab.correlationKey === correlationKey && activeTab.value === "mcp-logs"}
						/>
					) : null}

					<TabsContent value="raw" className="space-y-4">
						<PayloadBlock title={t("rawRecord")} code={JSON.stringify(displayLog, null, 2)} />
					</TabsContent>

					{pluginLogCount > 0 && detail?.plugin_logs && (
						<TabsContent value="plugins" className="space-y-3">
							<PluginLogsView pluginLogs={detail.plugin_logs} />
						</TabsContent>
					)}
				</Tabs>
			</SheetContent>
		</Sheet>
	);
}