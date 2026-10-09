import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdownMenu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";

const THEMES = [
	{ value: "light", icon: Sun },
	{ value: "dark", icon: Moon },
	{ value: "system", icon: Laptop },
] as const;

/** 按当前语言展示主题选项，主题持久值保持不变。 */
export function ThemeToggleItems() {
	const { t } = useTranslation("common");
	const { theme, setTheme } = useTheme();

	return (
		<>
			{THEMES.map(({ value, icon: Icon }) => (
				<DropdownMenuItem key={value} onClick={() => setTheme(value)} className="cursor-pointer" data-testid={`theme-option-${value}`}>
					<Icon className="size-4" strokeWidth={2} />
					<span className="flex-1">{t(`theme.${value}`)}</span>
					{theme === value && <Check className="text-muted-foreground size-3.5" strokeWidth={2.5} />}
				</DropdownMenuItem>
			))}
		</>
	);
}

/** 为主题切换提供本地化菜单、悬停提示和无障碍名称。 */
export function ThemeToggle() {
	const { t } = useTranslation("common");
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t("theme.toggle")}
							data-testid="theme-toggle"
							// size-8 box around a size-4 glyph, matching the notification and menu triggers. Equal boxes are
							// what keep the topbar icons evenly spaced and open their menus on the same line.
							className="text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-card data-[state=open]:text-accent-foreground size-8 border-0 ring-offset-0 outline-none select-none focus-visible:ring-0 data-[state=open]:border"
						>
							<Sun className="size-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" strokeWidth={2} />
							<Moon className="absolute size-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" strokeWidth={2} />
							<span className="sr-only">{t("theme.toggle")}</span>
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("theme.toggle")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end" sideOffset={2}>
				<ThemeToggleItems />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}