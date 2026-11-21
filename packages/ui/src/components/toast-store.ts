/**
 * Toast state and the imperative `toast` API. Tiny and dependency-free so it can sit in the entry
 * bundle; the Radix-based viewport loads on the first toast.
 */
export type ToastTone = "neutral" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** One action, e.g. Undo. `altText` describes how to do it without the toast (a11y). */
  action?: { label: string; onClick: () => void; altText?: string };
  /** Milliseconds before auto-dismiss (default 5000; errors 8000). */
  duration?: number;
  /** Reuse an id to replace a toast instead of stacking duplicates. */
  id?: string;
}

export interface ToastRecord extends ToastOptions {
  id: string;
  open: boolean;
}

let toasts: ToastRecord[] = [];
const listeners = new Set<() => void>();
let counter = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function updateToasts(next: ToastRecord[]): void {
  toasts = next;
  emit();
}

/** Imperative toast API. Works anywhere (query error handlers, event handlers). */
export const toast = {
  show(options: ToastOptions): string {
    counter += 1;
    const id = options.id ?? `toast-${counter}`;
    const record: ToastRecord = { ...options, id, open: true };
    // Keep at most three visible; replacing an id moves it to the front.
    updateToasts([...toasts.filter((item) => item.id !== id), record].slice(-3));
    return id;
  },
  success(title: string, options: Omit<ToastOptions, "title" | "tone"> = {}) {
    return toast.show({ ...options, title, tone: "success" });
  },
  error(title: string, options: Omit<ToastOptions, "title" | "tone"> = {}) {
    return toast.show({ ...options, title, tone: "error" });
  },
  dismiss(id: string) {
    updateToasts(toasts.map((item) => (item.id === id ? { ...item, open: false } : item)));
  },
  /** Test helper: drop every toast. */
  reset() {
    updateToasts([]);
  },
};

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastRecord[] {
  return toasts;
}
