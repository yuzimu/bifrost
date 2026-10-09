import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Validator } from "@/lib/utils/validation";
import { Save } from "lucide-react";
import { useTranslation } from "react-i18next";

interface FormFooterProps {
	validator: Validator;
	label: string;
	onCancel: () => void;
	isLoading: boolean;
	isEditing: boolean;
	hasPermission?: boolean;
}

/** 展示本地化表单操作，保留校验与权限决定的禁用状态。 */
export default function FormFooter({ validator, label, onCancel, isLoading, isEditing, hasPermission = true }: FormFooterProps) {
	const { t } = useTranslation("common");
	const isDisabled = isLoading || !validator.isValid() || !hasPermission;

	/** 按权限、保存状态和校验结果确定操作提示。 */
	const getTooltipMessage = () => {
		if (!hasPermission) return t("form.noPermission");
		if (isLoading) return t("form.saving");
		return validator.getFirstError() || t("form.fixErrors");
	};

	return (
		<DialogFooter className="mt-4">
			<Button type="button" variant="outline" onClick={onCancel} disabled={isLoading} data-testid="form-footer-cancel">
				{t("cancel")}
			</Button>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<span>
							<Button type="submit" disabled={isDisabled} data-testid="form-footer-submit">
								<Save className="h-4 w-4" />
								{isLoading ? t("form.saving") : t(isEditing ? "form.updateEntity" : "form.createEntity", { entity: label })}
							</Button>
						</span>
					</TooltipTrigger>
					{isDisabled && (
						<TooltipContent>
							<p>{getTooltipMessage()}</p>
						</TooltipContent>
					)}
				</Tooltip>
			</TooltipProvider>
		</DialogFooter>
	);
}