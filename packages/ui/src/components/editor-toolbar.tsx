import IconFileText from "~icons/lucide/file-text";
import { Toggle } from "./ui/toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

interface EditorToolbarProps {
  wrapText: boolean;
  onToggleWrapText: () => void;
}

export function EditorToolbar(props: EditorToolbarProps) {
  return (
    <div class="editor-toolbar no-print space-x-0.5">
      <Tooltip>
        <TooltipTrigger
          as={Toggle}
          size="sm"
          pressed={props.wrapText}
          onChange={props.onToggleWrapText}
          aria-label="Wrap text"
        >
          <IconFileText width={14} height={14} />
        </TooltipTrigger>
        <TooltipContent>Wrap text</TooltipContent>
      </Tooltip>
    </div>
  );
}
