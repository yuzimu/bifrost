import type { MCPCodeModeLimits } from "@/lib/types/config";
import i18n from "@/lib/i18n";

// Server-side bounds, mirrored from core/schemas MCPCodeModeLimits.Validate.
const MIN_VALUE_BYTES = 1024;
const MAX_NESTING_DEPTH = 1000;

export const CODE_MODE_LIMIT_FIELDS: { key: keyof MCPCodeModeLimits; label: string; description: string; defaultValue: number }[] = [
	{
		key: "max_source_bytes",
		get label() {
			return i18n.t("codeModeLimits.max_source_bytes.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_source_bytes.description", { ns: "config" });
		},
		defaultValue: 65536,
	},
	{
		key: "max_steps",
		get label() {
			return i18n.t("codeModeLimits.max_steps.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_steps.description", { ns: "config" });
		},
		defaultValue: 1000000,
	},
	{
		key: "max_memory_bytes",
		get label() {
			return i18n.t("codeModeLimits.max_memory_bytes.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_memory_bytes.description", { ns: "config" });
		},
		defaultValue: 67108864,
	},
	{
		key: "max_log_bytes",
		get label() {
			return i18n.t("codeModeLimits.max_log_bytes.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_log_bytes.description", { ns: "config" });
		},
		defaultValue: 65536,
	},
	{
		key: "max_tool_calls",
		get label() {
			return i18n.t("codeModeLimits.max_tool_calls.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_tool_calls.description", { ns: "config" });
		},
		defaultValue: 64,
	},
	{
		key: "max_value_bytes",
		get label() {
			return i18n.t("codeModeLimits.max_value_bytes.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_value_bytes.description", { ns: "config", min: MIN_VALUE_BYTES });
		},
		defaultValue: 1048576,
	},
	{
		key: "max_nesting_depth",
		get label() {
			return i18n.t("codeModeLimits.max_nesting_depth.label", { ns: "config" });
		},
		get description() {
			return i18n.t("codeModeLimits.max_nesting_depth.description", { ns: "config", max: MAX_NESTING_DEPTH });
		},
		defaultValue: 64,
	},
];

// Missing, undefined and 0 all mean "use the default", so they compare equal.
export function codeModeLimitsEqual(a: MCPCodeModeLimits | undefined, b: MCPCodeModeLimits | undefined): boolean {
	return CODE_MODE_LIMIT_FIELDS.every(({ key }) => (a?.[key] ?? 0) === (b?.[key] ?? 0));
}

// Returns 0 for an empty input (the default), the value for a whole number >= 0,
// and undefined for anything else so the caller can keep the previous value.
export function parseCodeModeLimitInput(value: string): number | undefined {
	if (value.trim() === "") return 0;
	if (!/^\d+$/.test(value.trim())) return undefined;
	return Number.parseInt(value, 10);
}

/** 按既有边界校验，返回当前语言的错误字符串。 */
export function validateCodeModeLimits(limits: MCPCodeModeLimits | undefined): string | null {
	if (!limits) return null;
	for (const { key, label } of CODE_MODE_LIMIT_FIELDS) {
		if ((limits[key] ?? 0) < 0) return i18n.t("codeModeLimits.negative", { ns: "config", label });
	}
	const valueBytes = limits.max_value_bytes ?? 0;
	if (valueBytes !== 0 && valueBytes < MIN_VALUE_BYTES) return i18n.t("codeModeLimits.valueMin", { ns: "config", min: MIN_VALUE_BYTES });
	if ((limits.max_nesting_depth ?? 0) > MAX_NESTING_DEPTH)
		return i18n.t("codeModeLimits.nestingMax", { ns: "config", max: MAX_NESTING_DEPTH });
	return null;
}