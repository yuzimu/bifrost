import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import GovernancePage from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <GovernancePage /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/governance")({
	component: RouteComponent,
});