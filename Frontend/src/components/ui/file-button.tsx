import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";

interface FileButtonProps extends Omit<ButtonProps, "type"> {
  accept?: string;
  onFile: (file: File) => void;
  children: React.ReactNode;
}

/** shadcn-style file picker: the only raw <input type="file"> in the app
 * lives inside this component — every caller renders a Button. */
const FileButton = React.forwardRef<HTMLButtonElement, FileButtonProps>(
  ({ accept, onFile, children, onClick, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    return (
      <>
        <Button
          ref={ref}
          type="button"
          onClick={(event) => {
            onClick?.(event);
            inputRef.current?.click();
          }}
          {...props}
        >
          {children}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onFile(file);
          }}
        />
      </>
    );
  },
);
FileButton.displayName = "FileButton";

export { FileButton };
