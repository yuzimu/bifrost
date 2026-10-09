/**
 * CEL Rule Builder for Routing Rules
 * Thin wrapper around the reusable CELRuleBuilder with routing-specific config
 */

import { CELBuilderMode, CELRuleBuilder as BaseCELRuleBuilder } from "@/components/ui/custom/celBuilder";
import { getRoutingFields } from "@/lib/config/celFieldsRouting";
import { celOperatorsRouting } from "@/lib/config/celOperatorsRouting";
import { convertRuleGroupToCEL, validateRegexPattern } from "@/lib/utils/celConverterRouting";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RuleGroupType } from "react-querybuilder";

interface CELRuleBuilderProps {
	onChange?: (celExpression: string, query: RuleGroupType) => void;
	initialQuery?: RuleGroupType;
	providers?: string[];
	models?: string[];
	allowCustomModels?: boolean;
	isLoading?: boolean;
	allowCelMode?: boolean;
	initialMode?: CELBuilderMode;
	initialCel?: string;
	onModeChange?: (mode: CELBuilderMode) => void;
	celError?: string | null;
}

/** 按当前语言生成显示字段，表达式与字段值沿用原有转换器。 */
export function CELRuleBuilder({
	onChange,
	initialQuery,
	providers = [],
	models = [],
	isLoading = false,
	allowCustomModels = false,
	allowCelMode = false,
	initialMode = "builder",
	initialCel = "",
	onModeChange,
	celError = null,
}: CELRuleBuilderProps) {
	const { t } = useTranslation("models");
	const fields = useMemo(() => getRoutingFields(providers, models, t), [providers, models, t]);
	const operators = useMemo(() => celOperatorsRouting.map((operator) => ({ ...operator })), [t]);
	const validateRegex = useCallback((pattern: string) => validateRegexPattern(pattern, t), [t]);

	return (
		<BaseCELRuleBuilder
			onChange={onChange}
			initialQuery={initialQuery}
			isLoading={isLoading}
			fields={fields}
			operators={operators}
			convertToCEL={convertRuleGroupToCEL}
			validateRegex={validateRegex}
			builderContext={{ allowCustomModels }}
			allowCelMode={allowCelMode}
			initialMode={initialMode}
			initialCel={initialCel}
			onModeChange={onModeChange}
			celError={celError}
		/>
	);
}