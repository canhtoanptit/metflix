/** A minimal cookie jar for tests: every Set-Cookie kept by name, sent back as one header. */
export function createCookieJar() {
  const cookies = new Map<string, string>();
  return {
    store(response: Response): void {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const separator = pair.indexOf("=");
        if (separator <= 0) continue;
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        // An emptied or expired cookie is a deletion.
        if (value === "" || /max-age=0/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header(): string {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}
