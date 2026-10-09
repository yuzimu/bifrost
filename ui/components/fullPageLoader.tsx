import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

function FullPageLoader({ className }: { className?: string }) {
	const { t } = useTranslation("common");
	return (
		<div className={cn("h-base pb-1/2 flex items-center justify-center", className)} role="status" aria-label={t("loading")}>
			<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
		</div>
	);
}

export default FullPageLoader;