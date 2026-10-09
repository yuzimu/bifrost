import { Badge } from "./ui/badge";
import { useTranslation } from "react-i18next";

export default function BetaBadge() {
	const { t } = useTranslation("shell");
	return <Badge variant="secondary">{t("pageTitle.beta")}</Badge>;
}