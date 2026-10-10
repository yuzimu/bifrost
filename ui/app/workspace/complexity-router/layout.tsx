import { createFileRoute } from "@tanstack/react-router";
import ComplexityRouterPage from "./page";
function RouteComponent() {
	return <ComplexityRouterPage />;
}
export const Route = createFileRoute("/workspace/complexity-router")({
	component: RouteComponent,
});