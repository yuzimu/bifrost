import { createFileRoute } from "@tanstack/react-router";
import ObservabilityPage from "./page";
function RouteComponent() {
	return <ObservabilityPage />;
}
export const Route = createFileRoute("/workspace/observability")({
	component: RouteComponent,
});