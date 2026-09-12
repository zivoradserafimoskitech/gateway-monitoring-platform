// §8: destructive actions used window.confirm, which is unstyled, untranslated
// and blocks the whole tab. AlertDialog was already in the component library.
import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import { Trash2 } from "lucide-react";

export function ConfirmButton({
  title,
  description,
  onConfirm,
  children,
  disabled,
  confirmLabel,
}: {
  title: string;
  description?: string;
  onConfirm: () => void;
  /** Custom trigger content; defaults to a small destructive icon button. */
  children?: ReactNode;
  disabled?: boolean;
  confirmLabel?: string;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {children ?? (
          <Button variant="ghost" size="sm" disabled={disabled} aria-label={title}>
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 hover:bg-red-700"
            onClick={onConfirm}
          >
            {confirmLabel ?? t.common.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
