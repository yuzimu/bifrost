import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import FullPageLoader from "@/components/fullPageLoader";
import { useGetCoreConfigQuery } from "@/lib/store";
import ConfigPage from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	const { isLoading } = useGetCoreConfigQuery({ fromDB: true });
	if (isLoading) {
		return <FullPageLoader />;
	}
	return childMatches.length === 0 ? <ConfigPage /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/config")({
	component: RouteComponent,
});