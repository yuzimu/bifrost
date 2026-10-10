import { useWebSocket } from "@/hooks/useWebSocket";
import {
	addNotification,
	hydrateNotificationPreferences,
	pruneExpiredNotifications,
	selectNotificationPreferences,
	setNotifications,
	useAppDispatch,
	useAppSelector,
	useGetNotificationsQuery,
} from "@/lib/store";
import type { Notification } from "@/lib/types/notifications";
import { readNotificationPreferences, writeNotificationPreferences } from "@/lib/notifications/preferences";
import { useEffect } from "react";
/** Expired rows are dropped this often so a tab left open overnight converges. */
const PRUNE_INTERVAL_MS = 60000;
export function useNotificationSync() {
	const dispatch = useAppDispatch();
	const { subscribe } = useWebSocket();
	const preferences = useAppSelector(selectNotificationPreferences);
	const scope = "local-admin";
	const { data } = useGetNotificationsQuery({ limit: 50 });
	useEffect(() => {
		const stored = readNotificationPreferences(scope);
		dispatch(hydrateNotificationPreferences({ scope, ...stored }));
	}, [dispatch, scope]);
	useEffect(() => {
		if (data?.notifications) dispatch(setNotifications(data.notifications));
	}, [data, dispatch]);
	useEffect(
		() =>
			subscribe("notification", (message) => {
				if (message.data?.id) dispatch(addNotification(message.data as Notification));
			}),
		[dispatch, subscribe],
	);
	useEffect(() => {
		const timer = setInterval(() => dispatch(pruneExpiredNotifications()), PRUNE_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [dispatch]);
	useEffect(() => {
		if (preferences.scope !== scope) return;
		writeNotificationPreferences(scope, preferences);
	}, [preferences, scope]);
}