import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import LogsPage from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	return <div className="flex h-full flex-col">{childMatches.length === 0 ? <LogsPage /> : <Outlet />}</div>;
}
export const Route = createFileRoute("/workspace/logs")({
	component: RouteComponent,
});