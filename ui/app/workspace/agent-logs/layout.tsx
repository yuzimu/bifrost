import { createFileRoute } from "@tanstack/react-router";
import AgentLogsPage from "./page";
import { useTranslation } from "react-i18next";
function RouteComponent() {
	const { t } = useTranslation("agents");
	return <AgentLogsPage />;
}
export const Route = createFileRoute("/workspace/agent-logs")({
	component: RouteComponent,
});