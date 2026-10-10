import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import CustomPricingPage from "./page";
function CustomPricingLayout({ children }: { children: React.ReactNode }) {
	return <>{children}</>;
}
function RouteComponent() {
	const childMatches = useChildMatches();
	return <CustomPricingLayout>{childMatches.length === 0 ? <CustomPricingPage /> : <Outlet />}</CustomPricingLayout>;
}
export const Route = createFileRoute("/workspace/custom-pricing")({
	component: RouteComponent,
});