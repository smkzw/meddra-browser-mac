export function openModal(dialog: HTMLDialogElement | null, dismiss: () => void) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }

  // Safari before 15.4 treats <dialog> as an ordinary element.
  const previous = document.activeElement;
  const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>("button, input, select, textarea"))
    .filter((element) => !element.hasAttribute("disabled") && element.getClientRects().length);
  dialog.setAttribute("data-legacy-modal", "");
  dialog.setAttribute("open", "");
  (controls()[0] ?? dialog).focus();

  function handleKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Tab") {
      const items = controls();
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      if (!items.includes(document.activeElement as HTMLElement) ||
          document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  }

  document.addEventListener("keydown", handleKey, true);
  return () => {
    document.removeEventListener("keydown", handleKey, true);
    dialog.removeAttribute("open");
    dialog.removeAttribute("data-legacy-modal");
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}
