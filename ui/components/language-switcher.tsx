import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdownMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changeLocale, getLocale, SUPPORTED_LOCALES, type SupportedLocale } from "@/lib/i18n";
import { Check, Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

/** 展示语言的原生名称并保存选择，悬停提示随当前语言更新。 */
export function LanguageSwitcher() {
	const { t, i18n } = useTranslation("common");
	const current = (i18n.resolvedLanguage ?? getLocale()) as SupportedLocale;

	const handleSelect = (locale: SupportedLocale) => {
		if (locale === current) return;
		void changeLocale(locale);
	};

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("language")}
							data-testid="language-switcher"
							className="text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-card data-[state=open]:text-accent-foreground size-8 border-0 ring-offset-0 outline-none select-none focus-visible:ring-0 data-[state=open]:border"
						>
							<Languages className="size-4" strokeWidth={2} />
							<span className="sr-only">{t("language")}</span>
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("language")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end" sideOffset={2}>
				{SUPPORTED_LOCALES.map(({ code, label }) => (
					<DropdownMenuItem
						key={code}
						onClick={() => handleSelect(code)}
						className="cursor-pointer"
						data-testid={`language-option-${code}`}
					>
						<span className="flex-1">{label}</span>
						{current === code && <Check className="text-muted-foreground size-3.5" strokeWidth={2.5} />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}