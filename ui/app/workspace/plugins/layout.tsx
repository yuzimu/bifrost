import { createFileRoute } from "@tanstack/react-router";
import PluginsPage from "./page";
function RouteComponent() {
	return <PluginsPage />;
}
export const Route = createFileRoute("/workspace/plugins")({
	component: RouteComponent,
});