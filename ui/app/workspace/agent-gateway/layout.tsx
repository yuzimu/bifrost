import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import AgentGatewayPage from "./page";
import { useTranslation } from "react-i18next";
function RouteComponent() {
	const { t } = useTranslation("agents");
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <AgentGatewayPage /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/agent-gateway")({
	component: RouteComponent,
});