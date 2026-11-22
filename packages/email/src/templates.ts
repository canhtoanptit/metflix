import type { EmailTemplate } from "./message.ts";

/**
 * Typed email templates (docs/BLUEPRINT-M2.md §8.2, FOUNDATION.md D-M2-19): each renders a
 * subject, an HTML body and a plain-text body from its data. Every interpolated value is escaped
 * for HTML; links must be absolute http(s) URLs (anything else is refused, so a template can
 * never carry a `javascript:` link). Dates are ISO instants, shown in UTC.
 *
 * Webflix is its own brand: wording, colours and layout are ours.
 */

export type SecurityChange =
  | "password-reset"
  | "password-changed"
  | "password-set"
  | "email-changed"
  | "identity-linked"
  | "identity-unlinked";

export interface EmailTemplateData {
  "verify-email": { link: string; expiresAt: string };
  "reset-password": { link: string; expiresAt: string };
  welcome: { signInMethod: string };
  receipt: {
    planName: string;
    amount: string;
    paidAt: string;
    periodEnd: string | null;
    invoiceUrl: string | null;
  };
  "payment-failed": { planName: string; amount: string; retryAt: string | null; updateUrl: string };
  "trial-ending": { planName: string; trialEndsAt: string; amount: string; manageUrl: string };
  "plan-changed": { fromPlan: string; toPlan: string; effectiveAt: string };
  cancellation: { planName: string; accessUntil: string; restartUrl: string };
  "new-sign-in": { device: string; method: string; at: string };
  "security-change": {
    change: SecurityChange;
    at: string;
    detail: string | null;
    manageUrl: string;
  };
  "data-export-ready": { link: string; expiresAt: string };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITIES[character] ?? character);
}

/** An absolute http(s) URL, or a TypeError: no other scheme ever reaches a template. */
export function safeLink(value: string): string {
  if (!URL.canParse(value)) throw new TypeError("A link must be an absolute URL");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("A link must be http(s)");
  }
  return url.href;
}

/** `22 November 2026, 14:05 UTC`. */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Not an instant: ${iso}`);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
  return `${day}, ${time} UTC`;
}

/** One line of the subject: no line breaks, ever (header injection). */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

interface Block {
  /** Plain text; escaped for HTML. */
  paragraphs: string[];
  action?: { label: string; href: string };
  /** Small print under the action. */
  footnote?: string;
}

const COLORS = {
  page: "#0b0b0d",
  card: "#16161a",
  text: "#f2f2f3",
  muted: "#a3a3ad",
  accent: "#e5484d",
};

function layout(subject: string, heading: string, block: Block): RenderedEmail {
  const action = block.action
    ? { label: block.action.label, href: safeLink(block.action.href) }
    : undefined;
  const paragraphs = block.paragraphs
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${COLORS.text}">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:12px 24px;border-radius:6px;background:${COLORS.accent};color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(action.label)}</a></p><p style="margin:0 0 16px;font-size:13px;line-height:20px;color:${COLORS.muted}">If the button does not work, copy this address into your browser: ${escapeHtml(action.href)}</p>`
    : "";
  const footnote = block.footnote
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:${COLORS.muted}">${escapeHtml(block.footnote)}</p>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:0;background:${COLORS.page};font-family:Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page}"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.card};border-radius:8px"><tr><td style="padding:32px"><p style="margin:0 0 24px;font-size:22px;font-weight:800;letter-spacing:0.5px;color:${COLORS.accent}">WEBFLIX</p><h1 style="margin:0 0 16px;font-size:24px;line-height:32px;color:${COLORS.text}">${escapeHtml(heading)}</h1>${paragraphs}${button}${footnote}</td></tr></table><p style="margin:16px 0 0;font-size:12px;color:${COLORS.muted}">You received this email because of your Webflix account.</p></td></tr></table></body></html>`;
  const text = [
    "WEBFLIX",
    "",
    heading,
    "",
    ...block.paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...(action ? [`${action.label}: ${action.href}`, ""] : []),
    ...(block.footnote ? [block.footnote, ""] : []),
    "You received this email because of your Webflix account.",
  ].join("\n");
  return { subject: oneLine(subject), html, text };
}

const SECURITY_CHANGES: Record<SecurityChange, string> = {
  "password-reset": "Your password was reset and every device was signed out.",
  "password-changed": "Your password was changed. Other devices were signed out.",
  "password-set": "A password was added to your account.",
  "email-changed": "The email address of your account was changed.",
  "identity-linked": "A sign-in method was linked to your account.",
  "identity-unlinked": "A sign-in method was removed from your account.",
};

type Renderers = { [T in EmailTemplate]: (data: EmailTemplateData[T]) => RenderedEmail };

const RENDERERS: Renderers = {
  "verify-email": (data) =>
    layout("Confirm your email address", "Confirm your email address", {
      paragraphs: [
        "Confirm that this is your email address so you can recover your account and link other ways to sign in.",
      ],
      action: { label: "Confirm email address", href: data.link },
      footnote: `This link works once and expires on ${formatInstant(data.expiresAt)}. If you did not create a Webflix account, ignore this email.`,
    }),
  "reset-password": (data) =>
    layout("Reset your Webflix password", "Reset your password", {
      paragraphs: [
        "Someone asked to reset the password of your Webflix account. If it was you, choose a new password below. Every device will be signed out.",
      ],
      action: { label: "Choose a new password", href: data.link },
      footnote: `This link works once and expires on ${formatInstant(data.expiresAt)}. If you did not ask for it, ignore this email: your password stays as it is.`,
    }),
  welcome: (data) =>
    layout("Welcome to Webflix", "Welcome to Webflix", {
      paragraphs: [
        `Your account is ready. You signed up with ${data.signInMethod}.`,
        "Choose a plan to start watching, then set up a profile for everyone at home.",
      ],
    }),
  receipt: (data) =>
    layout(`Your Webflix receipt: ${data.amount}`, "Thanks for your payment", {
      paragraphs: [
        `We received ${data.amount} for your ${data.planName} plan on ${formatInstant(data.paidAt)}.`,
        ...(data.periodEnd
          ? [`Your membership is paid until ${formatInstant(data.periodEnd)}.`]
          : []),
      ],
      ...(data.invoiceUrl ? { action: { label: "View invoice", href: data.invoiceUrl } } : {}),
    }),
  "payment-failed": (data) =>
    layout("We could not take your Webflix payment", "Your payment did not go through", {
      paragraphs: [
        `We could not collect ${data.amount} for your ${data.planName} plan.`,
        data.retryAt
          ? `We will try again on ${formatInstant(data.retryAt)}. Update your payment method to keep watching without interruption.`
          : "Update your payment method to keep watching.",
      ],
      action: { label: "Update payment method", href: data.updateUrl },
    }),
  "trial-ending": (data) =>
    layout("Your Webflix trial ends soon", "Your free trial ends soon", {
      paragraphs: [
        `Your ${data.planName} trial ends on ${formatInstant(data.trialEndsAt)}. After that you will be charged ${data.amount} a month unless you cancel.`,
      ],
      action: { label: "Manage membership", href: data.manageUrl },
    }),
  "plan-changed": (data) =>
    layout("Your Webflix plan changed", "Your plan changed", {
      paragraphs: [
        `Your plan changed from ${data.fromPlan} to ${data.toPlan} on ${formatInstant(data.effectiveAt)}.`,
      ],
    }),
  cancellation: (data) =>
    layout("Your Webflix membership is cancelled", "Your membership is cancelled", {
      paragraphs: [
        `You can keep watching on ${data.planName} until ${formatInstant(data.accessUntil)}.`,
        "Changed your mind? You can restart at any time.",
      ],
      action: { label: "Restart membership", href: data.restartUrl },
    }),
  "new-sign-in": (data) =>
    layout("New sign-in to your Webflix account", "New sign-in to your account", {
      paragraphs: [
        `Your account was signed in on ${data.device} with ${data.method} on ${formatInstant(data.at)}.`,
        "If this was not you, reset your password and sign out of all devices from your account page.",
      ],
    }),
  "security-change": (data) =>
    layout("A change to your Webflix account", "A change to your account", {
      paragraphs: [
        SECURITY_CHANGES[data.change],
        ...(data.detail ? [data.detail] : []),
        `When: ${formatInstant(data.at)}.`,
        "If this was not you, reset your password now and review the sign-in methods on your account page.",
      ],
      action: { label: "Review your account", href: data.manageUrl },
    }),
  "data-export-ready": (data) =>
    layout("Your Webflix data is ready to download", "Your data is ready to download", {
      paragraphs: [
        "The copy of your Webflix data you asked for is ready. Sign in first if you are asked to.",
      ],
      action: { label: "Download your data", href: data.link },
      footnote: `The link works until ${formatInstant(data.expiresAt)}. If you did not ask for this, change your password.`,
    }),
};

/** Render one template: subject, HTML and text. Throws a TypeError for an unsafe link. */
export function renderEmail<T extends EmailTemplate>(
  template: T,
  data: EmailTemplateData[T],
): RenderedEmail {
  const render = RENDERERS[template] as (input: EmailTemplateData[T]) => RenderedEmail;
  return render(data);
}
