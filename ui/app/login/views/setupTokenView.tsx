import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Form, FormControl, FormField, FormItem, FormLabel, useFormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useBranding } from "@/lib/hooks/useBranding";
import { SETUP_TOKEN_HEADER } from "@/lib/store/apis/setupToken";
import { setupTokenFormSchema, SetupTokenFormSchema } from "@/lib/types/schemas";
import { getApiBaseUrl } from "@/lib/utils/port";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Trans, useTranslation } from "react-i18next";

// Where the operator lands after the token is accepted: the security page holds the
// existing admin-account form, which is the step that lifts the lock.
const SECURITY_SETTINGS_PATH = "/workspace/config/security";

const CONFIG_SNIPPET = `{
  "setup_token": "env.BIFROST_SETUP_TOKEN"
}`;

/** 展示初始化令牌配置说明，保留配置字段和请求头原名。 */
function SetupTokenInstructions() {
	const { t } = useTranslation("login");
	return (
		<div className="text-muted-foreground space-y-3 text-sm" data-testid="setup-token-instructions">
			<p>{t("setup.instructions.intro")}</p>
			<ul className="list-disc space-y-1 pl-5">
				<li>
					<Trans ns="login" i18nKey="setup.instructions.environment" components={{ code: <code className="text-foreground" /> }} />
				</li>
				<li>
					<Trans ns="login" i18nKey="setup.instructions.config" components={{ code: <code className="text-foreground" /> }} />
				</li>
			</ul>
			<pre className="bg-muted text-foreground overflow-x-auto rounded-sm p-3 text-xs">{CONFIG_SNIPPET}</pre>
			<p>
				<Trans
					ns="login"
					i18nKey="setup.instructions.api"
					values={{ header: SETUP_TOKEN_HEADER }}
					components={{ code: <code className="text-foreground" /> }}
				/>
			</p>
		</div>
	);
}

/** 在渲染时翻译校验和服务端错误，语言切换不遗留旧语言提示。 */
function SetupTokenError() {
	const { t } = useTranslation("login");
	const { error, formMessageId } = useFormField();
	if (!error) return null;
	return (
		<p id={formMessageId} data-slot="form-message" className="text-destructive text-sm" data-testid="setup-token-error">
			{t(error.type === "server" ? error.message! : "setup.errors.required", { status: error.types?.status })}
		</p>
	);
}

interface SetupTokenViewProps {
	setupTokenConfigured: boolean;
}

/** 验证初始化令牌并建立 HttpOnly 会话，再前往安全设置创建管理员。 */
export default function SetupTokenView({ setupTokenConfigured }: SetupTokenViewProps) {
	const { t } = useTranslation("login");
	const { resolvedTheme } = useTheme();
	const { logoSrc, logoAlt } = useBranding(resolvedTheme === "dark");
	const [helpOpen, setHelpOpen] = useState(false);
	const navigate = useNavigate();
	const form = useForm<SetupTokenFormSchema>({
		resolver: zodResolver(setupTokenFormSchema),
		defaultValues: { setup_token: "" },
	});

	/** 仅发送令牌换取初始化会话，不在浏览器中持久化令牌。 */
	const onSubmit = async ({ setup_token }: SetupTokenFormSchema) => {
		let res: Response;
		try {
			// Trade the token for an HttpOnly setup session cookie. The token is sent this
			// once and never kept by the dashboard.
			res = await fetch(`${getApiBaseUrl()}/session/setup`, {
				method: "POST",
				credentials: "include",
				headers: { [SETUP_TOKEN_HEADER]: setup_token },
			});
		} catch {
			form.setError("setup_token", { type: "server", message: "setup.errors.unreachable" });
			return;
		}
		if (res.status === 401 || res.status === 403) {
			form.setError("setup_token", { type: "server", message: "setup.errors.invalid" });
			return;
		}
		if (!res.ok) {
			form.setError("setup_token", { type: "server", message: "setup.errors.status", types: { status: String(res.status) } });
			return;
		}
		form.reset();
		navigate({ to: SECURITY_SETTINGS_PATH });
	};

	return (
		<div className="relative flex min-h-screen items-center justify-center p-4">
			<div className="absolute top-4 right-4">
				<LanguageSwitcher />
			</div>
			<div className="w-full max-w-md">
				<div className="border-border bg-card w-full space-y-6 rounded-sm border p-8" data-testid="setup-token-view">
					<div className="flex items-center justify-center">
						<img src={logoSrc} alt={logoAlt} width={160} height={26} className="max-h-[40px] w-auto max-w-[220px] object-contain" />
					</div>

					<div className="space-y-2 text-center">
						<h1 className="text-foreground text-lg font-semibold">{t("setup.title")}</h1>
						<p className="text-muted-foreground text-sm">{t("setup.description")}</p>
					</div>

					{setupTokenConfigured ? (
						<>
							<Form {...form}>
								<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
									<FormField
										control={form.control}
										name="setup_token"
										render={({ field }) => (
											<FormItem>
												<FormLabel>{t("setup.token")}</FormLabel>
												<FormControl>
													<Input
														{...field}
														type="password"
														placeholder={t("setup.placeholder")}
														autoComplete="off"
														className="text-sm"
														data-testid="setup-token-input"
													/>
												</FormControl>
												<SetupTokenError />
											</FormItem>
										)}
									/>
									<Button
										type="submit"
										className="h-9 w-full text-sm"
										isLoading={form.formState.isSubmitting}
										disabled={form.formState.isSubmitting}
										data-testid="setup-token-submit"
									>
										{t("setup.continue")}
									</Button>
								</form>
							</Form>
							<Collapsible open={helpOpen} onOpenChange={setHelpOpen}>
								<CollapsibleTrigger
									className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors"
									data-testid="setup-token-help"
								>
									{t("setup.help")}
									<ChevronDown className={`h-4 w-4 transition-transform ${helpOpen ? "rotate-180" : ""}`} />
								</CollapsibleTrigger>
								<CollapsibleContent className="pt-3">
									<SetupTokenInstructions />
								</CollapsibleContent>
							</Collapsible>
						</>
					) : (
						<div className="space-y-4">
							<div className="bg-destructive/10 text-destructive rounded-sm p-3 text-sm">{t("setup.notConfigured")}</div>
							<SetupTokenInstructions />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}