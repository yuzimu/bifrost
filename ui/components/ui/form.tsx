import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import {
	Controller,
	FormProvider,
	useFormContext,
	useFormState,
	type ControllerProps,
	type FieldPath,
	type FieldValues,
	type FormProviderProps,
	type FieldErrors,
	type UseFormTrigger,
} from "react-hook-form";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

/** 切换语言时重新解析校验，仅回写已有本地校验错误路径，保留服务端错误与交互状态。 */
export function useFormErrorLanguageSync<TFieldValues extends FieldValues>(errors: FieldErrors<TFieldValues>, trigger: UseFormTrigger<TFieldValues>) {
	const { i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? i18n.language;
	const previousLocale = React.useRef(locale);
	const current = React.useRef({ errors, trigger });
	current.current = { errors, trigger };

	React.useEffect(() => {
		if (previousLocale.current === locale) return;
		previousLocale.current = locale;
		const paths: FieldPath<TFieldValues>[] = [];
		const collect = (value: unknown, path: string) => {
			if (!value || typeof value !== "object") return;
			if ("type" in value && typeof value.type === "string") {
				if (path && !["manual", "server"].includes(value.type)) paths.push(path as FieldPath<TFieldValues>);
				return;
			}
			if ("message" in value && typeof value.message === "string") return;
			for (const [key, child] of Object.entries(value)) {
				if (key !== "root" && key !== "ref") collect(child, path ? `${path}.${key}` : key);
			}
		};
		collect(current.current.errors, "");
		if (paths.length) void current.current.trigger(paths);
	}, [locale]);
}

function FormErrorLanguageSync() {
	const { trigger } = useFormContext();
	const { errors } = useFormState();
	useFormErrorLanguageSync(errors, trigger);
	return null;
}
/** 为现有 FormProvider 保留完整合同并同步校验错误的显示语言。 */
function Form<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
	children,
	...props
}: FormProviderProps<TFieldValues, TContext, TTransformedValues>) {
	return (
		<FormProvider {...props}>
			<FormErrorLanguageSync />
			{children}
		</FormProvider>
	);
}

type FormFieldContextValue<
	TFieldValues extends FieldValues = FieldValues,
	TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
	name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

const FormField = <TFieldValues extends FieldValues = FieldValues, TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>>({
	...props
}: ControllerProps<TFieldValues, TName>) => {
	return (
		<FormFieldContext.Provider value={{ name: props.name }}>
			<Controller {...props} />
		</FormFieldContext.Provider>
	);
};

const useFormField = () => {
	const fieldContext = React.useContext(FormFieldContext);
	const itemContext = React.useContext(FormItemContext);
	const { getFieldState } = useFormContext();
	const formState = useFormState({ name: fieldContext.name });
	const fieldState = getFieldState(fieldContext.name, formState);

	if (!fieldContext) {
		throw new Error("useFormField should be used within <FormField>");
	}

	const { id } = itemContext;

	return {
		id,
		name: fieldContext.name,
		formItemId: `${id}-form-item`,
		formDescriptionId: `${id}-form-item-description`,
		formMessageId: `${id}-form-item-message`,
		...fieldState,
	};
};

type FormItemContextValue = {
	id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

function FormItem({ className, ...props }: React.ComponentProps<"div">) {
	const id = React.useId();

	return (
		<FormItemContext.Provider value={{ id }}>
			<div data-slot="form-item" className={cn("grid gap-2", className)} {...props} />
		</FormItemContext.Provider>
	);
}

function FormLabel({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
	const { error, formItemId } = useFormField();

	return (
		<Label
			data-slot="form-label"
			data-error={!!error}
			className={cn("data-[error=true]:text-destructive", className)}
			htmlFor={formItemId}
			{...props}
		/>
	);
}

function FormControl({ ...props }: React.ComponentProps<typeof Slot>) {
	const { error, formItemId, formDescriptionId, formMessageId } = useFormField();

	return (
		<Slot
			data-slot="form-control"
			id={formItemId}
			aria-describedby={!error ? `${formDescriptionId}` : `${formDescriptionId} ${formMessageId}`}
			aria-invalid={!!error}
			{...props}
		/>
	);
}

function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
	const { formDescriptionId } = useFormField();

	return <p data-slot="form-description" id={formDescriptionId} className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

function FormMessage({ className, ...props }: React.ComponentProps<"p">) {
	const { error, formMessageId } = useFormField();
	const body = error ? String(error?.message ?? "") : props.children;

	if (!body) {
		return null;
	}

	return (
		<p data-slot="form-message" id={formMessageId} className={cn("text-destructive text-sm", className)} {...props}>
			{body}
		</p>
	);
}

export { useFormField, Form, FormItem, FormLabel, FormControl, FormDescription, FormMessage, FormField };
