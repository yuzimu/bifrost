// Side filter panel for the OAuth grants table, matching the pattern used by
// the MCP clients/library/sessions pages: a collapsible sidebar of checkbox
// sections, collapsing to a narrow rail with an active-filter-count badge.
// State/behavior mirrors mcpSessionsFilterSidebar.tsx; kept as its own copy
// since this page filters on unrelated fields.
import { FilterSidebarTrigger } from "@/components/filters/filterSidebarTrigger";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scrollArea";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGetVirtualKeysQuery } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ChevronDown, Fingerprint, KeyRound, LoaderCircle, PanelLeftClose, RotateCcw, Search, UserRound } from "lucide-react";
import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
const COLLAPSE_STORAGE_KEY = "oauth-grants-filter-sidebar-collapsed";
const VK_PAGE_SIZE = 25;
const USER_PAGE_SIZE = 25;
// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------
export interface OAuthGrantFilters {
	mode: string[]; // subset of ["user", "vk", "session"] → bf_mode
	virtual_key_id: string[]; // explicit VK IDs (vk-mode rows only)
}
export const EMPTY_FILTERS: OAuthGrantFilters = {
	mode: [],
	virtual_key_id: [],
};
interface FilterOption {
	value: string;
	label: string;
	icon?: React.ReactNode;
}
interface SidebarProps {
	filters: OAuthGrantFilters;
	onFiltersChange: (filters: OAuthGrantFilters) => void;
}
// ---------------------------------------------------------------------------
// OAuthGrantsFilterSidebar – orchestrator
// ---------------------------------------------------------------------------
/** 按当前语言展示授权筛选项，不改变身份模式及查询范围。 */
export function OAuthGrantsFilterSidebar({ filters, onFiltersChange }: SidebarProps) {
	const { t } = useTranslation("mcp");
	const modeOptions: FilterOption[] = [
		{ value: "user", label: t("sessions.filter.user"), icon: <UserRound className="size-3.5" /> },
		{
			value: "vk",
			label: t("sessions.filter.virtualKeyOption"),
			icon: <KeyRound className="size-3.5" />,
		},
		{
			value: "session",
			label: t("sessions.filter.session"),
			icon: <Fingerprint className="size-3.5" />,
		},
	];
	const isMobile = useIsMobile();
	const [collapsed, setCollapsed] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined") return;
		if (isMobile) {
			setCollapsed(true);
			return;
		}
		const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
		setCollapsed(stored === "true");
	}, [isMobile]);
	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			if (typeof window !== "undefined") {
				window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
			}
			return next;
		});
	}, []);
	const activeFilterCount = useMemo(() => filters.mode.length + filters.virtual_key_id.length, [filters]);
	const handleReset = useCallback(() => {
		onFiltersChange(EMPTY_FILTERS);
	}, [onFiltersChange]);
	// Mirrors mcpSessionsFilterSidebar's auth-mode guard: when Identity pins
	// the row set to exactly one mode, the other mode's picker can't match
	// anything, so hide it outright rather than leave a checkbox list that
	// would only ever come back empty. Selecting "Session" hides both, since
	// session-bound rows have no VK or user to pick. Neither/both selected
	// leaves both pickers visible.
	const modeOnly = filters.mode.length === 1 ? filters.mode[0] : null;
	const showVirtualKeyFilter = modeOnly !== "user" && modeOnly !== "session";
	const showUsersFilter = modeOnly !== "vk" && modeOnly !== "session";
	// A hidden picker's stale selection would otherwise keep silently
	// filtering (a VK pick surviving a switch to "User" identity, say) with
	// no visible control left to clear it — so drop it the moment its section
	// disappears.
	useEffect(() => {
		if (!showVirtualKeyFilter && filters.virtual_key_id.length > 0) {
			onFiltersChange({ ...filters, virtual_key_id: [] });
		}
	}, [showVirtualKeyFilter, filters, onFiltersChange]);
	useEffect(() => {}, [showUsersFilter, filters, onFiltersChange]);
	if (collapsed) {
		return (
			<FilterSidebarTrigger activeFilterCount={activeFilterCount} onClick={toggleCollapsed} testId="oauthGrantsFilterSidebar-toggle-show" />
		);
	}
	return (
		<div className="bg-card fixed inset-y-2 left-2 z-40 flex h-auto w-[calc(100vw-1rem)] max-w-72 shrink-0 flex-col rounded-md border shadow-xl md:static md:h-full md:w-64 md:max-w-none md:rounded-md md:shadow-none">
			<div className="flex h-11 items-center justify-between border-b pr-2 pl-5">
				<span className="text-sm font-semibold">{t("common.filters")}</span>
				<div className="flex items-center gap-1">
					{activeFilterCount > 0 && (
						<Button
							variant="outline"
							size="sm"
							className="text-muted-foreground h-7 px-2 text-xs"
							onClick={handleReset}
							data-testid="oauthGrantsFilterSidebar-reset-button"
						>
							<RotateCcw className="size-3" />
							{t("common.reset")}
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={toggleCollapsed}
						title={t("common.hideFilters")}
						aria-label={t("common.hideFilters")}
						data-testid="oauthGrantsFilterSidebar-toggle-hide"
					>
						<PanelLeftClose className="size-4" />
					</Button>
				</div>
			</div>

			<ScrollArea className="flex flex-1 overflow-y-auto p-2 pb-0" viewportClassName="no-table">
				<div className="flex grow flex-col gap-1">
					<CheckboxFilterSection
						title={t("oauthGrants.filter.identity")}
						options={modeOptions}
						selected={filters.mode}
						defaultOpen
						onChange={(mode) => onFiltersChange({ ...filters, mode })}
						testIdPrefix="oauth-grants-filter-mode"
					/>
					{showVirtualKeyFilter && <VirtualKeyFilterSection filters={filters} onFiltersChange={onFiltersChange} />}
					{showUsersFilter && <></>}
				</div>
			</ScrollArea>
		</div>
	);
}
// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------
function FilterSection({
	title,
	children,
	defaultOpen = false,
	onOpenChange,
	testId,
}: {
	title: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	testId?: string;
}) {
	const [open, setOpen] = useState(defaultOpen);
	useEffect(() => {
		if (defaultOpen) setOpen(true);
	}, [defaultOpen]);
	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		onOpenChange?.(next);
	};
	return (
		<Collapsible open={open} onOpenChange={handleOpenChange} className="last:pb-2">
			<CollapsibleTrigger
				className="flex h-8 w-full cursor-pointer items-center gap-1.5 px-2 py-2 text-sm font-medium hover:opacity-80"
				data-testid={testId}
			>
				<ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")} />
				<span>{title}</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-1">
				<div className="divide-border divide-y overflow-hidden rounded-sm border">{children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}
function CheckboxFilterItem({
	label,
	icon,
	checked,
	onCheckedChange,
	testId,
}: {
	label: string;
	icon?: React.ReactNode;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	testId?: string;
}) {
	return (
		<label className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm" data-testid={testId}>
			<Checkbox checked={checked} onCheckedChange={onCheckedChange} />
			{icon && <span className="text-muted-foreground">{icon}</span>}
			<span className="truncate">{label}</span>
		</label>
	);
}
function CheckboxFilterSection({
	title,
	options,
	selected,
	defaultOpen = false,
	onChange,
	testIdPrefix,
}: {
	title: string;
	options: FilterOption[];
	selected: string[];
	defaultOpen?: boolean;
	onChange: (selected: string[]) => void;
	testIdPrefix?: string;
}) {
	const hasActive = selected.length > 0;
	const toggle = (value: string) => {
		if (selected.includes(value)) {
			onChange(selected.filter((v) => v !== value));
		} else {
			onChange([...selected, value]);
		}
	};
	return (
		<FilterSection title={title} defaultOpen={defaultOpen || hasActive} testId={testIdPrefix ? `${testIdPrefix}-toggle` : undefined}>
			{options.map((option) => (
				<CheckboxFilterItem
					key={option.value}
					label={option.label}
					icon={option.icon}
					checked={selected.includes(option.value)}
					onCheckedChange={() => toggle(option.value)}
					testId={testIdPrefix ? `${testIdPrefix}-checkbox-${option.value}` : undefined}
				/>
			))}
		</FilterSection>
	);
}
function useAutoFocusOnOpen(isOpen: boolean) {
	const ref = useRef<HTMLInputElement>(null);
	// Skip the initial mount so focus isn't stolen when the section starts open
	// from URL state; only focus on an explicit open action by the user.
	const mounted = useRef(false);
	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			return;
		}
		if (isOpen) ref.current?.focus({ preventScroll: true });
	}, [isOpen]);
	return ref;
}
// SearchableCheckboxList – checkbox rows with a search input. Client-side label
// filtering is applied on top of the (debounced) onSearch callback so the caller
// can fetch server-side results. Mirrors the MCP sessions filter sidebar pattern.
function SearchableCheckboxList({
	items,
	isSelected,
	onToggle,
	placeholder,
	inputRef,
	testIdPrefix,
	onSearch,
	fetching,
}: {
	items: {
		key: string;
		label: string;
	}[];
	isSelected: (key: string) => boolean;
	onToggle: (key: string) => void;
	placeholder?: string;
	inputRef?: Ref<HTMLInputElement>;
	testIdPrefix?: string;
	onSearch?: (query: string) => void;
	fetching?: boolean;
}) {
	const { t } = useTranslation("mcp");
	const [query, setQuery] = useState("");
	const normalized = query.trim().toLowerCase();
	const filtered = normalized ? items.filter((item) => item.label.toLowerCase().includes(normalized)) : items;
	useEffect(() => {
		if (!onSearch) return;
		const timer = setTimeout(() => onSearch(query.trim()), 300);
		return () => clearTimeout(timer);
	}, [query, onSearch]);
	return (
		<>
			<div className="relative border-b">
				{fetching ? (
					<LoaderCircle className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin" />
				) : (
					<Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
				)}
				<Input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={placeholder ?? t("library.filter.searchPlaceholder")}
					className="h-8 border-0 pl-8 text-xs"
					data-testid={testIdPrefix ? `${testIdPrefix}-search` : undefined}
				/>
			</div>
			{filtered.map((item) => (
				<CheckboxFilterItem
					key={item.key}
					label={item.label}
					checked={isSelected(item.key)}
					onCheckedChange={() => onToggle(item.key)}
					testId={testIdPrefix ? `${testIdPrefix}-checkbox-${item.key}` : undefined}
				/>
			))}
			{filtered.length === 0 && <div className="text-muted-foreground flex h-9 items-center px-3 text-xs">{t("common.noResults")}</div>}
		</>
	);
}
// VirtualKeyFilterSection – restricts grants to a set of VKs, resolved via
// the same server-side search+limit VK picker the MCP filter sidebars use
// (governance/virtual-keys), rather than loading the full VK list — VK counts
// can be huge, so this only ever fetches a page at a time, scoped by the
// in-flight search text. The list only fetches once the section is opened or
// already has a selection, since most visits won't touch this filter.
function VirtualKeyFilterSection({ filters, onFiltersChange }: SidebarProps) {
	const { t } = useTranslation("mcp");
	const hasActive = filters.virtual_key_id.length > 0;
	const [opened, setOpened] = useState(hasActive);
	const [searchQuery, setSearchQuery] = useState("");
	const searchInputRef = useAutoFocusOnOpen(opened);
	const { data, isFetching } = useGetVirtualKeysQuery(
		{ limit: VK_PAGE_SIZE, offset: 0, search: searchQuery || undefined },
		{ skip: !opened && !hasActive },
	);
	const virtualKeys = data?.virtual_keys || [];
	const toggle = (vkId: string) => {
		const current = filters.virtual_key_id;
		const next = current.includes(vkId) ? current.filter((v) => v !== vkId) : [...current, vkId];
		onFiltersChange({ ...filters, virtual_key_id: next });
	};
	return (
		<FilterSection
			title={t("oauthGrants.filter.virtualKey")}
			defaultOpen={hasActive}
			onOpenChange={setOpened}
			testId="oauth-grants-filter-vk-toggle"
		>
			<SearchableCheckboxList
				inputRef={searchInputRef}
				placeholder={t("oauthGrants.filter.searchVirtualKeys")}
				items={virtualKeys.map((vk) => ({ key: vk.id, label: vk.name || vk.id }))}
				isSelected={(key) => filters.virtual_key_id.includes(key)}
				onToggle={toggle}
				onSearch={setSearchQuery}
				fetching={isFetching}
				testIdPrefix="oauth-grants-filter-vk"
			/>
		</FilterSection>
	);
}
// Stand-in for useUserSearchQuery when no OSS hook is registered — keeps the
// hooks-must-run-unconditionally rule satisfied below without a real fetch.
function useNoopUserSearchQuery() {
	return { data: undefined, isFetching: false };
}