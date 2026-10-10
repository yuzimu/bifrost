import { createFileRoute } from "@tanstack/react-router";
import WarpPage from "./page";
function RouteComponent() {
	return <WarpPage />;
}
export const Route = createFileRoute("/workspace/config/warp")({
	component: RouteComponent,
});