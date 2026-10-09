// Searchable A2A agent selector. The agents endpoint returns the full
// registration list in one call, so search filters client-side rather than
// re-querying per keystroke.

import {
	EntitySelector,
	type EntitySelectorCommonProps,
	type EntitySelectorModeProps,
	useEntitySelectorSearch,
} from "@/components/entitySelectors/entitySelector";
import { useGetAgentsQuery } from "@/lib/store";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export type AgentSelectorProps = EntitySelectorCommonProps & EntitySelectorModeProps;

/** 保留智能体筛选方式，仅翻译访问状态和默认实体名。 */
export function AgentSelector(props: AgentSelectorProps) {
	const { t } = useTranslation("models");
	const { open, setOpen, setSearch, debouncedSearch } = useEntitySelectorSearch();

	const { data, isFetching, isError } = useGetAgentsQuery();

	const options = useMemo(() => {
		const needle = debouncedSearch.trim().toLowerCase();
		return (data?.agents ?? [])
			.filter((agent) => !needle || agent.name.toLowerCase().includes(needle))
			.map((agent) => ({
				value: agent.name,
				label: agent.name,
				// Surfaces the two states that change what a grant means: an open
				// agent needs none, a disabled one will not answer.
				description: agent.allow_by_default ? t("selectorUi.openToAllKeys") : agent.enabled ? undefined : t("selectorUi.disabled"),
			}));
	}, [data, debouncedSearch, t]);

	return (
		<EntitySelector
			{...props}
			entityLabel={t("selectorUi.agent")}
			entityLabelPlural={t("selectorUi.agents")}
			options={options}
			isFetching={isFetching}
			isError={isError}
			open={open}
			onOpenChange={setOpen}
			onSearchChange={setSearch}
			isSearching={false}
			debouncedSearch={debouncedSearch}
		/>
	);
}