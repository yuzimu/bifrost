import { formatCost, formatLatency } from "@/app/workspace/dashboard/utils/chartUtils";
import { LogMessageCell } from "@/app/workspace/logs/views/columns";
import { getMCPArgumentPreview } from "@/lib/utils/mcpLogPresentation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProviderIconType, RenderProviderIcon } from "@/lib/constants/icons";
import {
  getProviderLabel,
  logAppDisplayName,
  mapAppToClientApp,
  mapUserAgentToApp,
  ProviderName,
  RequestTypeColors,
  RequestTypeLabels,
  StatusBarColors,
  type Status,
} from "@/lib/constants/logs";
import { useGetLogsQuery, useGetLogsStatsQuery } from "@/lib/store/apis/logsApi";
import { useGetMCPLogsQuery, useGetMCPLogsStatsQuery } from "@/lib/store/apis/mcpLogsApi";
import type { LogEntry, LogFilters, MCPToolLogEntry, MCPToolLogFilters } from "@/lib/types/logs";
import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/lib/utils/numbers";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { format, isValid } from "date-fns";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { dateFnsLocale } from "@/lib/i18n/dateLocale";

const PAGE_SIZE = 10;
const LLM_HEADERS = ["time", "", "type", "message", "model", "app", "latency", "tokens", "cost"];
const MCP_HEADERS = ["time", "", "tool", "server", "app", "latency", "cost"];

type Correlation = { session_id: string } | { agent_correlation_id: string };
type CorrelatedLogKind = "llm" | "mcp";

export function useCorrelatedLogCounts(correlation: Correlation | null, enabled: boolean) {
  const llmFilters = useMemo<LogFilters>(() => correlation ?? {}, [correlation]);
  const mcpFilters = useMemo<MCPToolLogFilters>(() => correlation ?? {}, [correlation]);
  const { data: llmStats } = useGetLogsStatsQuery(
    { filters: llmFilters },
    { skip: !enabled || !correlation },
  );
  const { data: mcpStats } = useGetMCPLogsStatsQuery(
    { filters: mcpFilters },
    { skip: !enabled || !correlation },
  );

  return {
    llmCount: llmStats?.total_requests ?? 0,
    mcpCount: mcpStats?.total_executions ?? 0,
  };
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {label} <span className="text-foreground font-mono tabular-nums">{value}</span>
    </span>
  );
}

function Pagination({
  page,
  total,
  loading,
  onPageChange,
}: {
  page: number;
  total: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation("agents");
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  return (
    <div
      className="flex items-center justify-between pt-2 text-xs"
      data-testid="correlated-logs-pagination"
    >
      <span className="text-muted-foreground">
        {t("paginationEntries", {
          start: page * PAGE_SIZE + 1,
          end: Math.min((page + 1) * PAGE_SIZE, total),
          total: total.toLocaleString(),
        })}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("previousPage")}
          disabled={loading || page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3" />
        </Button>
        <span>{t("paginationPage", { page: page + 1, total: totalPages })}</span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("nextPage")}
          disabled={loading || page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="size-3" />
        </Button>
      </div>
    </div>
  );
}

function CorrelatedTableHeader({ kind }: { kind: CorrelatedLogKind }) {
  const { t } = useTranslation("agents");
  const headers = kind === "llm" ? LLM_HEADERS : MCP_HEADERS;
  return (
    <TableHeader className="sticky top-0 z-10 bg-[#f9f9f9] dark:bg-[#27272a]">
      <TableRow>
        {headers.map((header, index) => (
          <TableHead
            key={`${header}-${index}`}
            className={cn("px-4 text-xs", header === "" && "w-1 px-0")}
          >
            {header ? t(header) : ""}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function CorrelatedStatusBar({ status }: { status: string }) {
  const { t } = useTranslation("agents");
  const validatedStatus: Status =
    status === "success" || status === "error" || status === "processing" ? status : "processing";
  return (
    <div
      title={t(validatedStatus)}
      aria-label={t(validatedStatus)}
      className={`h-8 w-1 shrink-0 rounded-sm ${StatusBarColors[validatedStatus]}`}
    />
  );
}

function CorrelatedApp({ appKey, userAgent }: { appKey?: string; userAgent?: string }) {
  const app = appKey ? mapAppToClientApp(appKey) : mapUserAgentToApp(userAgent);
  const label = logAppDisplayName(app, userAgent);
  return (
    <div className="flex min-w-0 items-center gap-2" title={userAgent}>
      {app.icon ? (
        <img
          className="shrink-0 rounded-sm"
          src={app.icon}
          alt={label}
          width={18}
          height={18}
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <span className="truncate text-xs">{label}</span>
    </div>
  );
}

function CorrelatedLLMRow({ log, search }: { log: LogEntry; search: Record<string, string> }) {
  const { t, i18n } = useTranslation("agents");
  const navigate = useNavigate();
  const timestamp = new Date(log.timestamp);
  const provider = log.provider as ProviderName | undefined;
  const tokenUsage = log.token_usage;
  const openLog = () =>
    navigate({ to: "/workspace/logs", search: { ...search, selected_log: log.id } });
  return (
    <TableRow className="cursor-pointer" onClick={openLog}>
      <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">
        {isValid(timestamp)
          ? format(timestamp, "MMM dd  HH:mm:ss", { locale: dateFnsLocale(i18n.language) })
          : log.timestamp}
      </TableCell>
      <TableCell className="w-1 px-0">
        <CorrelatedStatusBar status={log.status} />
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn(
            "w-fit font-mono text-[11px] uppercase",
            RequestTypeColors[log.object as keyof typeof RequestTypeColors],
          )}
        >
          {RequestTypeLabels[log.object as keyof typeof RequestTypeLabels] || log.object}
        </Badge>
      </TableCell>
      <TableCell className="max-w-md overflow-hidden">
        <LogMessageCell log={log} contentClassName="max-w-full" />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 items-center gap-2">
          {provider ? (
            <RenderProviderIcon provider={provider as ProviderIconType} size="xs" />
          ) : null}
          <div className="min-w-0 leading-tight">
            <span className="block truncate font-mono text-xs">
              {log.model || t("notAvailable")}
            </span>
            <span className="text-muted-foreground block truncate text-[10.5px]">
              {provider ? getProviderLabel(provider) : t("notAvailable")}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <CorrelatedApp appKey={log.app} userAgent={log.user_agent} />
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {log.latency == null ? t("notAvailable") : formatLatency(log.latency)}
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {tokenUsage ? formatCompactNumber(tokenUsage.total_tokens ?? 0) : t("notAvailable")}
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {log.cost == null ? t("notAvailable") : formatCost(log.cost)}
      </TableCell>
    </TableRow>
  );
}

function CorrelatedMCPRow({
  log,
  search,
}: {
  log: MCPToolLogEntry;
  search: Record<string, string>;
}) {
  const { t, i18n } = useTranslation("agents");
  const navigate = useNavigate();
  const timestamp = new Date(log.timestamp);
  const preview = getMCPArgumentPreview(log);
  const openLog = () =>
    navigate({ to: "/workspace/mcp-logs", search: { ...search, selected_log: log.id } });
  return (
    <TableRow className="cursor-pointer" onClick={openLog}>
      <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">
        {isValid(timestamp)
          ? format(timestamp, "MMM dd  HH:mm:ss", { locale: dateFnsLocale(i18n.language) })
          : log.timestamp}
      </TableCell>
      <TableCell className="w-1 px-0">
        <CorrelatedStatusBar status={log.status} />
      </TableCell>
      <TableCell className="max-w-md overflow-hidden">
        <span className="block truncate font-mono text-sm">{log.tool_name}</span>
        {preview ? (
          <span className="text-muted-foreground block truncate text-xs" title={preview}>
            {preview}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="w-fit max-w-full truncate font-mono">
          {log.source === "native" ? t("local") : log.server_label || "-"}
        </Badge>
      </TableCell>
      <TableCell>
        <CorrelatedApp appKey={log.app || log.app_key} userAgent={log.user_agent} />
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {log.latency == null ? t("notAvailable") : formatLatency(log.latency)}
      </TableCell>
      <TableCell className="font-mono text-xs tabular-nums">
        {log.cost == null ? t("notAvailable") : formatCost(log.cost)}
      </TableCell>
    </TableRow>
  );
}

/** 展示关联日志及本地化统计，不改变关联查询范围。 */
export function CorrelatedLogsContent({
  kind,
  correlation,
  active,
  sortOrder = "asc",
}: {
  kind: CorrelatedLogKind;
  correlation: Correlation;
  active: boolean;
  sortOrder?: "asc" | "desc";
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [correlation, sortOrder]);
  const filters = correlation;
  const llmFilters: LogFilters = filters;
  const mcpFilters: MCPToolLogFilters = filters;
  const isLLM = kind === "llm";
  const {
    data: llmData,
    isFetching: llmLoading,
    isError: llmError,
  } = useGetLogsQuery(
    {
      filters: llmFilters,
      pagination: {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort_by: "timestamp",
        order: sortOrder,
      },
    },
    { skip: !active || !isLLM },
  );
  const { data: llmStats } = useGetLogsStatsQuery({ filters: llmFilters }, { skip: !isLLM });
  const {
    data: mcpData,
    isFetching: mcpLoading,
    isError: mcpError,
  } = useGetMCPLogsQuery(
    {
      filters: mcpFilters,
      pagination: {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort_by: "timestamp",
        order: sortOrder,
      },
    },
    { skip: !active || isLLM },
  );
  const { data: mcpStats } = useGetMCPLogsStatsQuery({ filters: mcpFilters }, { skip: isLLM });

  const total = isLLM ? (llmStats?.total_requests ?? 0) : (mcpStats?.total_executions ?? 0);
  const loading = isLLM ? llmLoading : mcpLoading;
  const error = isLLM ? llmError : mcpError;
  const logs = isLLM ? (llmData?.logs ?? []) : (mcpData?.logs ?? []);
  const sourceSearch = location.search as Record<string, unknown>;
  const timeSearch: Record<string, string> = sourceSearch.period
    ? { period: String(sourceSearch.period) }
    : sourceSearch.start_time && sourceSearch.end_time
      ? { start_time: String(sourceSearch.start_time), end_time: String(sourceSearch.end_time) }
      : {};
  const fullPageSearch: Record<string, string> = {
    ...timeSearch,
    ...("session_id" in correlation
      ? { session_id: correlation.session_id }
      : { agent_correlation_id: correlation.agent_correlation_id }),
  };

  return (
    <TabsContent value={`${kind}-logs`} className="space-y-3 px-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {isLLM ? (
            <>
              <Stat
                label={t("requests")}
                value={(llmStats?.total_requests ?? 0).toLocaleString()}
              />
              <Stat label={t("cost")} value={formatCost(llmStats?.total_cost ?? 0)} />
              <Stat label={t("tokens")} value={(llmStats?.total_tokens ?? 0).toLocaleString()} />
              <Stat label={t("success")} value={`${(llmStats?.success_rate ?? 0).toFixed(1)}%`} />
              <Stat
                label={t("averageLatency")}
                value={formatLatency(llmStats?.average_latency ?? 0)}
              />
            </>
          ) : (
            <>
              <Stat
                label={t("executions")}
                value={(mcpStats?.total_executions ?? 0).toLocaleString()}
              />
              <Stat label={t("cost")} value={formatCost(mcpStats?.total_cost ?? 0)} />
              <Stat label={t("success")} value={`${(mcpStats?.success_rate ?? 0).toFixed(1)}%`} />
              <Stat
                label={t("averageLatency")}
                value={formatLatency(mcpStats?.average_latency ?? 0)}
              />
            </>
          )}
        </div>
        <Link
          to={isLLM ? "/workspace/logs" : "/workspace/mcp-logs"}
          search={fullPageSearch}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          {t("viewAll")} <ExternalLink className="size-3" />
        </Link>
      </div>

      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        </div>
      ) : error ? (
        <div className="text-destructive flex h-24 items-center justify-center rounded-sm border text-sm">
          {t("correlatedLoadFailed", { kind: isLLM ? "LLM" : "MCP" })}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center rounded-sm border text-sm">
          {t("noCorrelatedLogs", { kind: isLLM ? "LLM" : "MCP" })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-sm border">
          <Table containerClassName="max-h-[50vh] overflow-auto" className="min-w-max">
            <CorrelatedTableHeader kind={kind} />
            <TableBody>
              {isLLM
                ? (llmData?.logs ?? []).map((log) => (
                    <CorrelatedLLMRow key={log.id} log={log} search={fullPageSearch} />
                  ))
                : (mcpData?.logs ?? []).map((log) => (
                    <CorrelatedMCPRow key={log.id} log={log} search={fullPageSearch} />
                  ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={page} total={total} loading={loading} onPageChange={setPage} />
    </TabsContent>
  );
}