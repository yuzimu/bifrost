import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
export default function ConfigPage() {
	const navigate = useNavigate();
	useEffect(() => {
		{
			navigate({ to: "/workspace/config/client-settings", replace: true });
		}
	}, [navigate]);
	return null;
}