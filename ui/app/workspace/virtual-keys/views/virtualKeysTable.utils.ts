import i18n from "@/lib/i18n";

// Bulk rotation returns one previous_value_expires_at per key, each computed from
// its own time.Now() on the server, so the deadlines in one response can differ.

/**
 * Picks the single grace deadline to show for a bulk rotation: the latest
 * deadline across the returned keys, i.e. the time after which no retired
 * value authenticates anymore. Returns null when no key has a grace window.
 */
export function latestGraceDeadline(virtualKeys: { previous_value_expires_at?: string | null }[]): string | null {
	let latest: string | null = null;
	for (const vk of virtualKeys) {
		const deadline = vk.previous_value_expires_at;
		if (deadline && (latest === null || new Date(deadline).getTime() > new Date(latest).getTime())) {
			latest = deadline;
		}
	}
	return latest;
}

/** 统一 OSS 表格与 CSV 的团队及客户归属标签。 */
export function assignedToLabel(vk: {
	team?: { name: string };
	customer?: { name: string };
	business_unit_id?: string;
	business_unit?: { name: string };
	assigned_user?: { name: string; email: string } | null;
}): string | null {
	if (vk.team) return i18n.t("virtualKeys.teamNamed", { ns: "models", name: vk.team.name });
	if (vk.customer) return i18n.t("virtualKeys.customerNamed", { ns: "models", name: vk.customer.name });
	return null;
}

/** 导出真实 OSS 归属；没有团队或客户时保持单元格为空。 */
export function csvAssignedToCell(vk: {
	team?: { name: string };
	customer?: { name: string };
	business_unit_id?: string;
	business_unit?: { name: string };
	assigned_user?: { name: string; email: string } | null;
}): string {
	const label = assignedToLabel(vk);
	if (label) return label;

	return "";
}
