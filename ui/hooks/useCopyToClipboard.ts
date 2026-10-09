import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface UseCopyToClipboardOptions {
	successMessage?: string;
	errorMessage?: string;
	resetDelay?: number;
}

/** 默认复制提示随语言更新，显式传入的提示和重置时长保持优先。 */
export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
	const { t } = useTranslation("common");
	const { successMessage, errorMessage, resetDelay = 2000 } = options;
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	/** 复制成功后更新短暂状态，失败时保留用户输入。 */
	const copy = useCallback(
		async (text: string) => {
			try {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				toast.success(successMessage === undefined ? t("clipboard.copied") : successMessage);

				if (timeoutRef.current) clearTimeout(timeoutRef.current);
				timeoutRef.current = setTimeout(() => setCopied(false), resetDelay);
			} catch {
				toast.error(errorMessage === undefined ? t("clipboard.failed") : errorMessage);
			}
		},
		[successMessage, errorMessage, resetDelay, t],
	);

	return { copy, copied };
}