import FullPageLoader from "@/components/fullPageLoader";
import PageTitle from "@/components/pageTitle";
import { Button } from "@/components/ui/button";
import { SecretVarInput } from "@/components/ui/secretVarInput";
import { getErrorMessage, useGetCoreConfigQuery, useUpdateCoreConfigMutation } from "@/lib/store";
import { CoreConfig, DefaultCoreConfig } from "@/lib/types/config";
import { SecretVar } from "@/lib/types/schemas";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";

const secretVarEquals = (a?: SecretVar, b?: SecretVar) =>
  (a?.value ?? "") === (b?.value ?? "") &&
  (a?.ref ?? "") === (b?.ref ?? "") &&
  (a?.type ?? "plain_text") === (b?.type ?? "plain_text");

/** 本地化网关设置界面，保留草稿版本和保存控制。 */
export default function AgentGatewayView() {
  const { t } = useTranslation("agents");
  const hasSettingsUpdateAccess = useRbac(RbacResource.Settings, RbacOperation.Update);
  const {
    data: bifrostConfig,
    isLoading: isConfigLoading,
    error: configError,
    refetch,
  } = useGetCoreConfigQuery({ fromDB: true });
  const config = bifrostConfig?.client_config;
  const [updateCoreConfig, { isLoading }] = useUpdateCoreConfigMutation();
  const [localConfig, setLocalConfig] = useState<CoreConfig>(DefaultCoreConfig);
  const draftRevision = useRef(0);
  const syncedRevision = useRef(0);

  useEffect(() => {
    if (bifrostConfig && config && draftRevision.current === syncedRevision.current) {
      setLocalConfig(config);
    }
  }, [config, bifrostConfig]);

  const hasChanges = useMemo(() => {
    if (!config) return false;
    return !secretVarEquals(localConfig.a2a_external_client_url, config.a2a_external_client_url);
  }, [config, localConfig]);

  const handleExternalURLChange = useCallback(
    (value: SecretVar) => {
      draftRevision.current += 1;
      if (secretVarEquals(value, config?.a2a_external_client_url)) {
        syncedRevision.current = draftRevision.current;
      }
      setLocalConfig((prev) => ({ ...prev, a2a_external_client_url: value }));
    },
    [config?.a2a_external_client_url],
  );

  const handleSave = useCallback(async () => {
    const savedRevision = draftRevision.current;
    try {
      if (!bifrostConfig) {
        toast.error(t("configurationNotLoaded"));
        return;
      }
      await updateCoreConfig({
        ...bifrostConfig,
        client_config: {
          ...bifrostConfig.client_config,
          a2a_external_client_url: localConfig.a2a_external_client_url,
        },
      }).unwrap();
      syncedRevision.current = savedRevision;
      toast.success(t("settingsUpdated"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }, [bifrostConfig, localConfig, updateCoreConfig, t]);

  if (isConfigLoading && !bifrostConfig) {
    return <FullPageLoader />;
  }

  if (configError && !bifrostConfig) {
    return (
      <div
        className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6"
        data-testid="agent-gateway-settings-load-error"
      >
        <PageTitle title={t("settingsTitle")}>{t("settingsDescription")}</PageTitle>
        <div className="border-destructive/30 bg-destructive/5 flex flex-col gap-3 rounded-sm border p-4">
          <p className="text-destructive text-sm font-medium">{t("settingsLoadFailed")}</p>
          <p className="text-muted-foreground text-sm">{getErrorMessage(configError)}</p>
          <div>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("retry")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6"
      data-testid="agent-gateway-settings-view"
    >
      <PageTitle title={t("settingsTitle")}>{t("settingsDescription")}</PageTitle>
      <div className="space-y-4">
        <div className="space-y-2 rounded-sm border p-4">
          <label htmlFor="a2a-external-client-url" className="text-sm font-medium">
            {t("externalClientUrl")}
          </label>
          <p className="text-muted-foreground text-sm">
            <Trans
              t={t}
              i18nKey="externalClientDescription"
              components={{
                code: <code className="text-xs" />,
                b: <b />,
                env: <code className="text-xs" />,
              }}
            />
          </p>
          <SecretVarInput
            id="a2a-external-client-url"
            data-testid="a2a-external-client-url-input"
            placeholder={t("externalClientPlaceholder")}
            value={localConfig.a2a_external_client_url}
            onChange={handleExternalURLChange}
            disabled={!config || !hasSettingsUpdateAccess}
          />
        </div>
      </div>
      <div className="flex justify-end pt-2">
        <Button
          onClick={handleSave}
          disabled={!hasChanges || isLoading || !hasSettingsUpdateAccess}
          data-testid="agent-gateway-settings-save-btn"
        >
          {isLoading ? t("saving") : t("saveChanges")}
        </Button>
      </div>
    </div>
  );
}