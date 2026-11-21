import type { JsonValue } from "@webflix/contracts";
import type { z } from "zod";
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from "../encoding.ts";
import { AppError } from "../errors.ts";

/**
 * Opaque pagination cursors: base64url of a JSON value. Cursors are not secret and not
 * signed; anything decoded from one is validated with a schema and only narrows a query the
 * caller is already authorised for.
 */
export function encodeCursor(value: JsonValue): string {
  return base64UrlEncode(utf8Encode(JSON.stringify(value)));
}

/** Returns null for malformed or schema-invalid cursors (callers answer `validation_failed`). */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(utf8Decode(base64UrlDecode(cursor))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The answer to a cursor that does not decode: the client's mistake, never "page one". */
export function invalidCursor(): AppError {
  return new AppError("validation_failed", {
    issues: [
      { location: "query", path: "cursor", message: "Invalid cursor", code: "invalid_cursor" },
    ],
  });
}
