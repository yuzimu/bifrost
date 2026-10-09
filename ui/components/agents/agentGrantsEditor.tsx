import { AgentSelector } from "@/components/entitySelectors/agentSelector";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

interface AgentGrantsEditorProps {
  /** Granted agent names. Agents are keyed by name, so the name is the grant. */
  value: string[];
  onChange: (agentNames: string[]) => void;
  label?: string;
  /** Overridable so a holder other than a virtual key (a project, say) can say what the grant means. */
  tooltip?: ReactNode;
}

/** 编辑虚拟密钥的智能体授权，保留调用方自定义标签和说明。 */
export function AgentGrantsEditor({ value, onChange, label, tooltip }: AgentGrantsEditorProps) {
  const { t } = useTranslation("agents");
  const add = (option: { value: string }) => {
    if (value.includes(option.value)) return;
    onChange([...value, option.value]);
  };

  const remove = (name: string) => onChange(value.filter((v) => v !== name));

  return (
    <div className="mt-6 space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{label ?? t("grantLabel")}</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Info className="text-muted-foreground h-3 w-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {tooltip ?? (
                <p>
                  <Trans
                    t={t}
                    i18nKey="grantTooltip"
                    components={{ path: <span className="font-medium" /> }}
                  />
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <AgentSelector
        mode="add"
        fullWidth
        placeholder={t("selectAgentToAdd")}
        onSelect={add}
        excludeIds={value}
      />

      {value.length > 0 && (
        <div className="divide-y overflow-hidden rounded-md border">
          {value.map((name) => (
            <div key={name} className="flex items-center justify-between gap-2 px-3 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="text-muted-foreground truncate text-xs">/agents/a2a/{name}</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("removeName", { name })}
                onClick={() => remove(name)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}