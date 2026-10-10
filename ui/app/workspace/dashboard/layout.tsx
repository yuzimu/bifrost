import { createFileRoute } from "@tanstack/react-router";
import DashboardPage from "./page";
function RouteComponent() {
	return <DashboardPage />;
}
export const Route = createFileRoute("/workspace/dashboard")({
	component: RouteComponent,
});