import { NoPermissionView } from "@/components/noPermissionView";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { createFileRoute } from "@tanstack/react-router";
import AgentLogsPage from "./page";
import { useTranslation } from "react-i18next";

function RouteComponent() {
  const { t } = useTranslation("agents");
  const hasViewAgentLogsAccess = useRbac(RbacResource.AgentLogs, RbacOperation.View);
  if (!hasViewAgentLogsAccess) {
    return <NoPermissionView entity={t("agentLogs")} />;
  }
  return <AgentLogsPage />;
}

export const Route = createFileRoute("/workspace/agent-logs")({
  component: RouteComponent,
});