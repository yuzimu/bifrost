import { TRIAL_EXPIRY } from "@/lib/constants/config";
import { cn } from "@/lib/utils";
import { differenceInDays } from "date-fns";
import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

/** 本地化试用到期提示及联系主题，保留原有到期判定。 */
export default function TrialExpiryBanner() {
	const { t } = useTranslation("shell");
	if (!TRIAL_EXPIRY) return null;

	const daysRemaining = differenceInDays(TRIAL_EXPIRY, new Date());
	const expired = daysRemaining < 0;
	if (!expired && daysRemaining > 7) return null;
	const critical = !expired && daysRemaining <= 3;

	const subject = t(expired ? "trial.expiredSubject" : "trial.extendSubject");
	const supportHref = `mailto:contact@getmaxim.ai?subject=${encodeURIComponent(subject)}`;

	return (
		<div
			id="trial-notification-banner"
			className={cn(
				"sticky top-0 z-10 flex w-full items-center justify-center gap-2 rounded-tl-md rounded-tr-md px-4 py-2 text-xs font-medium",
				expired || critical ? "bg-[#ffebea] text-red-700 dark:text-red-400" : "bg-[#fff4e4] text-amber-700 dark:text-amber-400",
			)}
			role="status"
		>
			<AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
			<span>
				<Trans
					ns="shell"
					i18nKey={expired ? "trial.expired" : "trial.expires"}
					count={daysRemaining}
					components={{
						link: <a href={supportHref} className="font-semibold underline underline-offset-2" data-testid="trial-contact-link" />,
					}}
				/>
			</span>
		</div>
	);
}