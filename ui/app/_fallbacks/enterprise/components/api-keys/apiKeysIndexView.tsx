import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useGetCoreConfigQuery } from "@/lib/store";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { Link } from "@tanstack/react-router";
import { Copy, InfoIcon, KeyRound } from "lucide-react";
import { useMemo } from "react";
import { Trans, useTranslation } from "react-i18next";
import ContactUsView from "../views/contactUsView";

/** 按认证配置展示本地化说明，代码示例与安全配置保持原样。 */
export default function APIKeysView() {
	const { t } = useTranslation("config");
	const { t: te } = useTranslation("enterprise");
	const { data: bifrostConfig, isLoading } = useGetCoreConfigQuery({ fromDB: true });
	const isAuthConfigure = useMemo(() => {
		return bifrostConfig?.auth_config?.is_enabled;
	}, [bifrostConfig]);

	const curlExample = `# Base64 encode your username:password
# Example: echo -n "username:password" | base64
curl --location 'http://localhost:8080/v1/chat/completions'
--header 'Content-Type: application/json' 
--header 'Accept: application/json' 
--header 'Authorization: Basic <base64_encoded_username:password>' 
--data '{ 
  "model": "openai/gpt-4", 
  "messages": [ 
    { 
      "role": "user", 
      "content": "explain big bang?" 
    } 
  ] 
}'`;

	const { copy: copyToClipboard } = useCopyToClipboard();

	if (isLoading) {
		return <div>{t("apiKeys.loading")}</div>;
	}
	if (!isAuthConfigure) {
		return (
			<Alert variant="default">
				<InfoIcon className="text-muted h-4 w-4" />
				<AlertDescription>
					<p className="text-md text-muted-foreground">
						{t("apiKeys.needSecurity")}{" "}
						<Link to="/workspace/config/security" className="text-md text-primary underline">
							{t("apiKeys.configureSecurity")}
						</Link>
						.<br />
						<br />
						{t("apiKeys.needSecurityAfter")}
					</p>
				</AlertDescription>
			</Alert>
		);
	}

	const isInferenceAuthDisabled = !(bifrostConfig?.client_config?.enforce_auth_on_inference ?? false);

	return (
		<div className="mx-auto w-full max-w-4xl space-y-4">
			<Alert variant="default">
				<InfoIcon className="text-muted h-4 w-4" />
				<AlertDescription>
					<p className="text-md text-muted-foreground">
						{isInferenceAuthDisabled ? (
							<Trans
								t={te}
								i18nKey="apiKeys.inferenceAuthDisabled"
								components={{
									strong: <strong />,
									credentials: <code className="bg-muted rounded px-1 py-0.5 text-sm" />,
								}}
							/>
						) : (
							<Trans
								t={te}
								i18nKey="apiKeys.basicAuth"
								components={{ credentials: <code className="bg-muted rounded px-1 py-0.5 text-sm" /> }}
							/>
						)}
					</p>
					{!isInferenceAuthDisabled && (
						<>
							<br />
							<p className="text-md text-muted-foreground">
								<strong>{t("apiKeys.example")}</strong>
							</p>

							<div className="relative mt-2 w-full min-w-0 overflow-x-auto">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => copyToClipboard(curlExample)}
									className="absolute top-2 right-2 z-10 h-8"
									aria-label={te("apiKeys.copyExample")}
									title={te("apiKeys.copyExample")}
								>
									<Copy className="h-4 w-4" />
								</Button>
								<pre className="bg-muted min-w-max rounded p-3 pr-12 font-mono text-sm whitespace-pre">{curlExample}</pre>
							</div>
						</>
					)}
				</AlertDescription>
			</Alert>

			<ContactUsView
				className="mt-4 rounded-md border px-3 py-8"
				icon={<KeyRound size={48} />}
				title={t("enterprise.apiKeysTitle")}
				description={t("enterprise.apiKeysDescription")}
				readmeLink="https://docs.getbifrost.io/enterprise/api-keys"
			/>
		</div>
	);
}