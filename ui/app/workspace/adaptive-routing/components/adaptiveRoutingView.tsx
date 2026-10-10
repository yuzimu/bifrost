import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	useGetForkAdaptiveConfigQuery,
	useGetForkAdaptiveSnapshotQuery,
	useReleaseForkHeldKeysMutation,
	useSaveForkAdaptiveConfigMutation,
} from "@/lib/store/apis/forkFeaturesApi";
import type { AdaptiveConfig, AdaptiveMetric, ReleaseHoldRequest } from "@/lib/types/forkFeatures";
import { Link } from "@tanstack/react-router";
import { Loader2, Save, Unlock } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
	ApiError,
	Choice,
	ConfirmAction,
	FeatureHeader,
	Field,
	QueryState,
	timestamp,
} from "../../guardrails/components/featurePrimitives";

export function AdaptiveShell({ active, children }: { active: "overview" | "settings" | "held"; children: ReactNode }) {
	const { t } = useTranslation("forkFeatures");
	return (
		<div className="min-w-0 space-y-4 p-4">
			<nav className="flex flex-wrap gap-4 border-b text-sm" aria-label={t("adaptive.title")}>
				{(
					[
						{ key: "overview", to: "/workspace/adaptive-routing" },
						{ key: "settings", to: "/workspace/adaptive-routing/settings" },
						{ key: "held", to: "/workspace/adaptive-routing/incidents" },
					] as const
				).map((tab) => (
					<Link
						key={tab.key}
						to={tab.to}
						className={`py-2 ${active === tab.key ? "border-primary border-b-2 font-medium" : "text-muted-foreground"}`}
					>
						{t(`adaptive.${tab.key}`)}
					</Link>
				))}
			</nav>
			{children}
		</div>
	);
}

/** 只轮询管理端观测快照，刷新与释放操作均不会向模型发起探测。 */
export function AdaptiveRoutingView({ heldOnly = false }: { heldOnly?: boolean }) {
	const { t } = useTranslation("forkFeatures");
	const [poll, setPoll] = useState("5");
	const [search, setSearch] = useState("");
	const query = useGetForkAdaptiveSnapshotQuery(undefined, { pollingInterval: Number(poll) * 1000, skipPollingIfUnfocused: true });
	const [release, releaseState] = useReleaseForkHeldKeysMutation();
	const [releasing, setReleasing] = useState<{ body: ReleaseHoldRequest; name: string } | null>(null);
	const [error, setError] = useState<unknown>();
	const matches = (row: { provider: string; model?: string; key_id?: string }) =>
		`${row.provider} ${row.model ?? ""} ${row.key_id ?? ""}`.toLowerCase().includes(search.toLowerCase());
	const levels = {
		directions: (query.data?.routes ?? []).filter((row) => !row.key_id),
		routes: (query.data?.routes ?? []).filter((row) => !!row.key_id),
	};
	const held = (query.data?.held_keys ?? []).filter(matches);
	const heldView = (
		<QueryState loading={query.isLoading} error={query.error} empty={!held.length}>
			<Table>
				<TableHeader>
					<TableRow>
						{["provider", "model", "key"].map((key) => (
							<TableHead key={key}>{t(`common.${key}`)}</TableHead>
						))}
						{["reason", "heldAt", "until"].map((key) => (
							<TableHead key={key}>{t(`adaptive.${key}`)}</TableHead>
						))}
						<TableHead>{t("common.status")}</TableHead>
						<TableHead>{t("common.actions")}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{held.map((hold) => (
						<TableRow key={`${hold.provider}:${hold.model}:${hold.key_id}`}>
							<TableCell>{hold.provider}</TableCell>
							<TableCell className="max-w-52 break-words whitespace-normal">{hold.model || "\u2014"}</TableCell>
							<TableCell className="max-w-52 break-all whitespace-normal">{hold.key_id}</TableCell>
							<TableCell className="max-w-64 break-words whitespace-normal">
								{t(`adaptive.reasons.${hold.failure_class}`, { defaultValue: hold.failure_class })}
							</TableCell>
							<TableCell>{timestamp(hold.held_at)}</TableCell>
							<TableCell>{timestamp(hold.check_due_at)}</TableCell>
							<TableCell>
								{t(hold.checking ? "adaptive.probe" : Date.parse(hold.check_due_at) <= Date.now() ? "adaptive.due" : "adaptive.waiting")}
							</TableCell>
							<TableCell>
								<Button
									size="sm"
									variant="outline"
									disabled={releaseState.isLoading}
									onClick={() => {
										setError(undefined);
										setReleasing({
											name: `${hold.provider} / ${hold.key_id} / ${hold.model || "*"}`,
											body: { provider: hold.provider, key_id: hold.key_id, ...(hold.model ? { model: hold.model } : {}) },
										});
									}}
								>
									<Unlock className="size-3.5" />
									{t("adaptive.release")}
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</QueryState>
	);
	return (
		<AdaptiveShell active={heldOnly ? "held" : "overview"}>
			<FeatureHeader title={t(heldOnly ? "adaptive.held" : "adaptive.title")} busy={query.isFetching} refresh={() => void query.refetch()}>
				<Button
					variant="outline"
					disabled={!query.data?.held_keys.length || releaseState.isLoading || !!query.error}
					onClick={() => {
						setError(undefined);
						setReleasing({ body: {}, name: t("adaptive.releaseAll") });
					}}
				>
					<Unlock className="size-4" />
					{t("adaptive.releaseAll")}
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
				<span className="text-muted-foreground text-xs">
					{t("common.snapshot")}: {query.fulfilledTimeStamp ? timestamp(new Date(query.fulfilledTimeStamp).toISOString()) : "\u2014"}
				</span>
			</div>
			{heldOnly ? (
				heldView
			) : (
				<Tabs defaultValue="directions">
					<TabsList className="max-w-full">
						<TabsTrigger value="directions">{t("adaptive.directions")}</TabsTrigger>
						<TabsTrigger value="routes">{t("adaptive.routes")}</TabsTrigger>
						<TabsTrigger value="held">{t("adaptive.held")}</TabsTrigger>
					</TabsList>
					{(["directions", "routes"] as const).map((level) => (
						<TabsContent key={level} value={level}>
							<QueryState loading={query.isLoading} error={query.error} empty={!levels[level].filter(matches).length}>
								<MetricTable rows={levels[level].filter(matches)} showKey={level === "routes"} />
							</QueryState>
						</TabsContent>
					))}
					<TabsContent value="held">{heldView}</TabsContent>
				</Tabs>
			)}
			<ConfirmAction
				open={!!releasing}
				title={t("adaptive.releaseConfirm", { name: releasing?.name })}
				description={t("adaptive.releaseDescription")}
				busy={releaseState.isLoading}
				error={error}
				onClose={() => setReleasing(null)}
				onConfirm={() => {
					if (!releasing) return;
					setError(undefined);
					void (async () => {
						try {
							const result = await release(releasing.body).unwrap();
							await query.refetch().unwrap();
							setReleasing(null);
							toast.success(t("adaptive.released", { count: result.count }));
						} catch (err) {
							setError(err);
						}
					})();
				}}
			/>
		</AdaptiveShell>
	);
}

/** 展示服务端原始量纲，归一化延时与权重因子不冒充绝对延时和流量份额。 */
function MetricTable({ rows, showKey }: { rows: AdaptiveMetric[]; showKey: boolean }) {
	const { t } = useTranslation("forkFeatures");
	const format = (value: number, percentage = false) =>
		Number.isFinite(value)
			? `${(percentage ? value * 100 : value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${percentage ? "%" : ""}`
			: "\u2014";
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{t("common.provider")}</TableHead>
					<TableHead>{t("common.model")}</TableHead>
					{showKey && <TableHead>{t("common.key")}</TableHead>}
					<TableHead>{t("common.status")}</TableHead>
					{["latency", "errorRate", "throughput", "weight", "requests"].map((key) => (
						<TableHead className="text-right" key={key}>
							{t(`adaptive.${key}`)}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((metric) => (
					<TableRow key={`${metric.provider}:${metric.model}:${metric.key_id}`}>
						<TableCell>{metric.provider}</TableCell>
						<TableCell className="max-w-52 break-words whitespace-normal">{metric.model}</TableCell>
						{showKey && <TableCell className="max-w-52 break-all whitespace-normal">{metric.key_id}</TableCell>}
						<TableCell>
							<span
								className={
									metric.state === "Failed"
										? "text-destructive"
										: metric.state === "Healthy"
											? "text-green-700 dark:text-green-400"
											: "text-muted-foreground"
								}
							>
								{t(`adaptive.${metric.state}`, { defaultValue: metric.state })}
							</span>
						</TableCell>
						<TableCell className="text-right tabular-nums">{format(metric.latency_per_100_tokens_ms)}</TableCell>
						<TableCell className="text-right tabular-nums">{format(metric.error_rate, true)}</TableCell>
						<TableCell className="text-right tabular-nums">{format(metric.tokens_per_second)}</TableCell>
						<TableCell className="text-right tabular-nums">{format(metric.adaptive_factor)}</TableCell>
						<TableCell className="text-right tabular-nums">{format(metric.requests)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

export function AdaptiveSettingsView() {
	const { t } = useTranslation("forkFeatures");
	const query = useGetForkAdaptiveConfigQuery();
	const [save, state] = useSaveForkAdaptiveConfigMutation();
	const [draft, setDraft] = useState<AdaptiveConfig | null>(null);
	const [error, setError] = useState<unknown>();
	const [discard, setDiscard] = useState(false);
	const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(query.data);
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty]);
	const value = draft ?? query.data;
	const submit = async () => {
		if (!value) return;
		setError(undefined);
		try {
			await save(value).unwrap();
			await query.refetch().unwrap();
			setDraft(null);
			toast.success(t("common.savedVerified"));
		} catch (err) {
			setError(err);
		}
	};
	return (
		<AdaptiveShell active="settings">
			<FeatureHeader
				title={t("adaptive.settings")}
				busy={query.isFetching}
				refresh={() => {
					if (dirty) setDiscard(true);
					else void query.refetch();
				}}
			/>
			<QueryState loading={query.isLoading} error={query.error} empty={!value}>
				{value && (
					<div className="max-w-3xl space-y-4">
						<fieldset disabled={state.isLoading} className="divide-y">
							{(Object.keys(value) as (keyof AdaptiveConfig)[]).map((key) => (
								<label key={key} className="flex min-w-0 items-center justify-between gap-4 py-4 text-sm">
									<span className="break-words">{t(`adaptive.${key}`)}</span>
									<Switch
										checked={value[key]}
										onCheckedChange={(checked) => setDraft({ ...value, [key]: checked })}
										aria-label={t(`adaptive.${key}`)}
										data-testid={`adaptive-${key}`}
									/>
								</label>
							))}
						</fieldset>
						<ApiError error={error} />
						<div className="flex flex-wrap items-center gap-3">
							<Button disabled={!dirty || state.isLoading} onClick={() => void submit()} data-testid="adaptive-save-config">
								{state.isLoading ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
								{t("common.save")}
							</Button>
							<Button variant="outline" disabled={!dirty || state.isLoading} onClick={() => setDiscard(true)}>
								{t("common.cancel")}
							</Button>
							<span className="text-muted-foreground text-xs">{t(dirty ? "common.unsaved" : "common.saved")}</span>
						</div>
					</div>
				)}
			</QueryState>
			<ConfirmAction
				open={discard}
				title={t("common.discard")}
				description={t("common.discardDescription")}
				onClose={() => setDiscard(false)}
				onConfirm={() => {
					setDraft(null);
					setDiscard(false);
					void query.refetch();
				}}
			/>
		</AdaptiveShell>
	);
}