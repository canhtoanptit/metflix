/**
 * @webflix/email (docs/BLUEPRINT-M2.md §8.2): the message every sender takes and its validation,
 * typed templates rendered to HTML and text, the HTTP provider sender and provider webhooks.
 * Web-standard APIs only; the SMTP sender (TCP) is `@webflix/email/smtp`, Node only.
 */
export * from "./http.ts";
export * from "./message.ts";
export * from "./templates.ts";
export * from "./webhooks.ts";
