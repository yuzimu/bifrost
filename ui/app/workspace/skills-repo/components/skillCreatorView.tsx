"use client";
import { useCreateSkillMutation } from "@/lib/store/apis/skillsApi";
import { getErrorMessage } from "@/lib/store/apis/baseApi";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSkillForm } from "./helpers";
import { SkillEditView } from "../forms/skillEditForm";
// ---------- SkillCreateView ----------
export function SkillCreateView({ onCreated, onBack }: { onCreated: (id: string) => void; onBack: () => void }) {
	const { t } = useTranslation("config");
	const [createSkill, { isLoading }] = useCreateSkillMutation();
	const form = useSkillForm();
	// Create mode always serves the new version — serve param is intentionally unused
	const handleCreate = async () => {
		if (!form.runValidation()) return;
		try {
			const result = await createSkill(form.getPayload()).unwrap();
			toast.success(t("skillsRepo.toastCreated"));
			onCreated(result.skill.id);
		} catch (err: unknown) {
			toast.error(t("skillsRepo.toastCreateFailed"), {
				description: getErrorMessage(err),
			});
		}
	};
	return <SkillEditView form={form} onSave={() => handleCreate()} onCancel={onBack} onBack={onBack} isSaving={isLoading} mode="create" />;
}