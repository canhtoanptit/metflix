// Vite's import.meta.glob (provided by Vitest), declared locally: contracts does not depend on vite.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>;
}
