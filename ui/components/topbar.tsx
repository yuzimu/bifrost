import { LanguageSwitcher } from "@/components/language-switcher";
import NotificationCenter from "@/components/notificationCenter";
import { ThemeToggle } from "@/components/themeToggle";
import WarpLauncher from "@/components/warp/warpLauncher";
import { deriveTitleFromPathname, getRouteTitleI18nKey } from "@/components/topbar.utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdownMenu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useDescriptionSlotRef, useMobileFilterSlotRef, useTopbarTitle } from "@/lib/contexts/topbarContext";
import type { TopbarTitleValue } from "@/lib/contexts/topbarContext.utils";
import { useBranding } from "@/lib/hooks/useBranding";
import { useAppDispatch, useGetCoreConfigQuery, useGetVersionQuery, useLogoutMutation } from "@/lib/store";
import { baseApi } from "@/lib/store/apis/baseApi";
import { cn } from "@/lib/utils";
import { BooksIcon, DiscordLogoIcon, GithubLogoIcon } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BugIcon, LogOut, Menu } from "lucide-react";
import { useTheme } from "next-themes";
import { Fragment, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
/** 优先采用页面标题，其余固定路由按当前语言显示导航标题。 */
function usePageTitle() {
	const { t } = useTranslation("shell");
	const pathname = useLocation({ select: (location) => location.pathname });
	const override = useTopbarTitle();
	const i18nKey = useMemo(() => getRouteTitleI18nKey(pathname), [pathname]);
	const derived = useMemo(() => deriveTitleFromPathname(pathname), [pathname]);
	if (override) return override;
	if (i18nKey) return t(i18nKey);
	if (!pathname.split("?")[0].split("/").filter(Boolean).length) {
		return t("titles.dashboard");
	}
	return derived;
}
/**
 * Renders the topbar heading — either a plain title or a breadcrumb trail.
 *
 * The trail keeps the same `text-base font-semibold` scale as a plain title, so
 * a nested page doesn't read as visually demoted; only the ancestor crumbs are
 * muted, leaving the current page as the emphasised one.
 */
function TopbarHeading({ title }: { title: TopbarTitleValue }) {
	const navigate = useNavigate();
	if (!Array.isArray(title)) {
		return <h1 className="hidden truncate text-base font-semibold md:block">{title}</h1>;
	}
	return (
		<h1 className="hidden min-w-0 items-center gap-1.5 text-base font-semibold md:flex" data-testid="topbar-breadcrumbs">
			{title.map((crumb, index) => {
				const isLast = index === title.length - 1;
				return (
					<Fragment key={`${crumb.label}-${index}`}>
						{index > 0 && <span className="text-muted-foreground/50 shrink-0 font-normal">/</span>}
						{(crumb.to || crumb.onSelect) && !isLast ? (
							<button
								type="button"
								onClick={() => (crumb.onSelect ? crumb.onSelect() : navigate({ to: crumb.to! }))}
								className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer transition-colors"
								data-testid={`topbar-breadcrumb-${index}`}
							>
								{crumb.label}
							</button>
						) : (
							// The current page is never a link, even if a `to`/`onSelect` was supplied.
							<span className={cn("truncate", !isLast && "text-muted-foreground")}>{crumb.label}</span>
						)}
					</Fragment>
				);
			})}
		</h1>
	);
}
/**
 * Topbar renders the strip above the inset content card. It deliberately
 * carries no background of its own so it reads as the same surface as the
 * sidebar — both simply show the page body background, since <Sidebar> is
 * rendered with `bg-transparent border-none`.
 *
 * It is 52px tall (h-13) with pt-1, putting its centred row at y=28 — the same
 * axis as the sidebar logo, which SidebarHeader's `mt-1 + p-2` around an h-8 row
 * centres at 28. 52px is also where the sidebar's search input starts, so the
 * content card below lines up with it. Keep this in sync with
 * --app-topbar-height in globals.css — every full-height page measures itself
 * against that variable.
 */
export default function Topbar() {
	const { t } = useTranslation("shell");
	const title = usePageTitle();
	const setDescriptionSlot = useDescriptionSlotRef();
	const setMobileFilterSlot = useMobileFilterSlotRef();
	const navigate = useNavigate();
	const [logout] = useLogoutMutation();
	const dispatch = useAppDispatch();
	const { data: coreConfig } = useGetCoreConfigQuery({});
	// Shares the sidebar's RTK Query cache entry, so this costs no extra request.
	const { data: version } = useGetVersionQuery();
	const { resolvedTheme } = useTheme();
	const { logoSrc, logoAlt } = useBranding(resolvedTheme === "dark");
	useEffect(() => {}, []);
	const isAuthEnabled = coreConfig?.auth_config?.is_enabled;
	const canLogout = isAuthEnabled;
	const externalLinks = useMemo(
		() => [
			{
				title: t("topbar.discord"),
				url: "https://discord.gg/exN5KAydbU",
				icon: DiscordLogoIcon,
			},
			{
				title: t("topbar.github"),
				url: "https://github.com/maximhq/bifrost",
				icon: GithubLogoIcon,
			},
			{
				title: t("topbar.reportBug"),
				url: "https://github.com/maximhq/bifrost/issues/new?title=[Bug Report]&labels=bug&type=bug&projects=maximhq/1",
				icon: BugIcon,
				strokeWidth: 1.5,
			},
			{
				title: t("topbar.docs"),
				url: "https://docs.getbifrost.ai",
				icon: BooksIcon,
				strokeWidth: 1,
			},
		],
		[t],
	);
	const handleLogout = async () => {
		try {
			await logout().unwrap();
		} catch {
			// Fall through: a failed server-side logout still means the user
			// intended to end the session locally.
		}
		// Navigate first so the dashboard's polled queries unmount, then drop
		// the cache. Resetting while they are mounted refetches all of them.
		await navigate({ to: "/login" });
		dispatch(baseApi.util.resetApiState());
	};
	return (
		<header className="flex h-13 w-full shrink-0 items-center gap-2 px-3 pt-1 md:pr-3 md:pl-0" data-testid="topbar-container-root">
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<SidebarTrigger className="shrink-0 md:hidden" />
				<img className="h-[22px] w-auto max-w-[120px] object-contain md:hidden" src={logoSrc} alt={logoAlt} width={70} height={70} />
				{/* text-base font-semibold, which is the size this heading has actually
            rendered at: Tailwind has no --text-md token, so the text-md it used
            to carry emitted no font-size rule and it simply inherited 0.95rem. */}
				<TopbarHeading title={title} />
				{/* Anchor for <PageTitle>'s description popover. Pages portal into
            this node, so the topbar never has to know their content. */}
				<span ref={setDescriptionSlot} className="hidden shrink-0 items-center gap-2 md:flex" />
			</div>

			{/* Theme stays a first-class topbar control rather than a menu entry —
                it's a display preference, not an account action. */}
			<span ref={setMobileFilterSlot} className="flex shrink-0 items-center md:hidden" />
			<NotificationCenter />
			<LanguageSwitcher />
			<ThemeToggle />
			<WarpLauncher />

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					{
						<button
							type="button"
							data-testid="topbar-menu-btn"
							aria-label={t("topbar.openMenu")}
							className="text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-card data-[state=open]:text-accent-foreground flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors data-[state=open]:border"
						>
							<Menu className="size-4" strokeWidth={2} />
						</button>
					}
				</DropdownMenuTrigger>

				<DropdownMenuContent align="end" sideOffset={2} className="w-60">
					<DropdownMenuGroup>
						{externalLinks.map((item) => (
							<DropdownMenuItem key={item.title} asChild>
								<a href={item.url} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
									<item.icon className="size-4" size={16} weight="regular" strokeWidth={item.strokeWidth} />
									<span className="truncate">{item.title}</span>
								</a>
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>

					{canLogout && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleLogout} data-testid="topbar-logout-btn" className="cursor-pointer">
								<LogOut className="size-4" strokeWidth={2} />
								<span>{t("topbar.signOut")}</span>
							</DropdownMenuItem>
						</>
					)}

					{/* Informational tail row: a Label, not an Item, so it never takes
        keyboard focus, highlights, or closes the menu on click. */}
					{version && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuLabel className="text-muted-foreground flex items-center justify-between gap-2 py-1.5 text-xs font-normal">
								<span>{t("topbar.version")}</span>
								<span className="truncate font-mono">{version}</span>
							</DropdownMenuLabel>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</header>
	);
}