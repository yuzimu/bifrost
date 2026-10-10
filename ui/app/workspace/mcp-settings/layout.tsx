import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import MCPSettingsPage from "./page";
function RouteComponent() {
	const { t } = useTranslation("config");
	return <MCPSettingsPage />;
}
export const Route = createFileRoute("/workspace/mcp-settings")({
	component: RouteComponent,
});