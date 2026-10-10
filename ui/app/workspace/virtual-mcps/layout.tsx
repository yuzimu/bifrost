import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import VirtualMCPsPage from "./page";
function RouteComponent() {
	const { t } = useTranslation("mcp");
	return <VirtualMCPsPage />;
}
export const Route = createFileRoute("/workspace/virtual-mcps")({
	component: RouteComponent,
});