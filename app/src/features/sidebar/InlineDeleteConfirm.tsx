import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useModalFocus } from "../modal/useModalFocus";

type InlineDeleteConfirmProps = {
  open: boolean;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function InlineDeleteConfirm({
  open,
  deleting,
  onConfirm,
  onCancel,
}: InlineDeleteConfirmProps) {
  const { t: tHistory } = useTranslation("history");
  const dialogRef = useModalFocus<HTMLElement>(open);

  if (!open) {
    return null;
  }

  return (
    <div
      className="sidebar-delete-confirm-backdrop"
      role="presentation"
      onClick={deleting ? undefined : onCancel}
    >
      <section
        ref={dialogRef}
        className="sidebar-delete-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={tHistory("confirm.ariaLabel")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !deleting) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <TriangleAlert size={20} />
        <div>
          <h3>{tHistory("confirm.title")}</h3>
          <p>{tHistory("confirm.body")}</p>
        </div>
        <div className="sidebar-delete-confirm-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onCancel}
            disabled={deleting}
            autoFocus
          >
            {tHistory("confirm.cancel")}
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? tHistory("confirm.deleting") : tHistory("confirm.delete")}
          </button>
        </div>
      </section>
    </div>
  );
}
