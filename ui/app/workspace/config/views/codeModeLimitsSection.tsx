import { Input } from "@/components/ui/input";
import type { MCPCodeModeLimits } from "@/lib/types/config";
import { CODE_MODE_LIMIT_FIELDS, parseCodeModeLimitInput } from "./codeModeLimits.utils";
import { useTranslation } from "react-i18next";

interface CodeModeLimitsSectionProps {
	value: MCPCodeModeLimits | undefined;
	onChange: (value: MCPCodeModeLimits) => void;
	disabled?: boolean;
}

/** 空输入仍表示默认值；字段文案随当前界面语言更新。 */
export function CodeModeLimitsSection({ value, onChange, disabled }: CodeModeLimitsSectionProps) {
	const { t } = useTranslation("config");
	return (
		<div className="space-y-4 rounded-sm border p-4" data-testid="mcp-code-mode-limits">
			<div className="space-y-0.5">
				<p className="text-sm font-medium">{t("codeModeLimits.title")}</p>
				<p className="text-muted-foreground text-sm">{t("codeModeLimits.description")}</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				{CODE_MODE_LIMIT_FIELDS.map((field) => {
					const id = `mcp-code-mode-${field.key.replaceAll("_", "-")}`;
					const current = value?.[field.key];
					return (
						<div key={field.key} className="space-y-1">
							<label htmlFor={id} className="text-sm font-medium">
								{field.label}
							</label>
							<p className="text-muted-foreground text-xs">{field.description}</p>
							<Input
								id={id}
								data-testid={`${id}-input`}
								type="number"
								min="0"
								className="w-40"
								placeholder={field.defaultValue.toString()}
								value={current ? current.toString() : ""}
								onChange={(e) => {
									const parsed = parseCodeModeLimitInput(e.target.value);
									if (parsed !== undefined) {
										onChange({ ...value, [field.key]: parsed });
									}
								}}
								disabled={disabled}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}