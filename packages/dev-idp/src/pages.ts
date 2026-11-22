/**
 * The issuer's HTML: the development sign-in page, the form_post auto-submit page, the sign-out
 * pages and the error page. No external assets, no inline event handlers; the only inline style
 * and script carry a per-response nonce. Every interpolated value goes through `escapeHtml`.
 */
import { randomToken } from "./encoding.ts";
import {
  FAULT_CATALOGUE,
  FAULT_NAMES,
  type FaultName,
  type FaultScope,
  isFlowFault,
} from "./faults.ts";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Template tag that escapes every interpolation unless it is already `Html`. */
class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

type Interpolation = string | number | Html | readonly Html[] | null | undefined | false;

function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = strings[0] ?? "";
  values.forEach((value, index) => {
    if (value instanceof Html) out += value.value;
    else if (Array.isArray(value)) out += value.map((item: Html) => item.value).join("");
    else if (value !== null && value !== undefined && value !== false) {
      out += escapeHtml(String(value));
    }
    out += strings[index + 1] ?? "";
  });
  return new Html(out);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f3ef;--fg:#18181b;--muted:#55555d;--card:#fff;--line:#cfcdc6;--accent:#6a2bd9;--accent-fg:#fff;--focus:#0b57d0;--error:#b3261e;--stripe-a:#ffd84d;--stripe-b:#f2c200}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--fg:#ececf1;--muted:#a6a6b0;--card:#1c1c21;--line:#3a3a44;--accent:#b48cff;--accent-fg:#16002f;--focus:#8ab4ff;--error:#ffb4ab}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.banner{background:repeating-linear-gradient(-45deg,var(--stripe-a) 0 14px,var(--stripe-b) 14px 28px);color:#111;border-bottom:3px solid #111;padding:.6rem 1rem;text-align:center;font-weight:700;letter-spacing:.02em}
.banner span{background:var(--stripe-a);padding:.15rem .5rem;border-radius:.25rem}
main{max-width:36rem;margin:0 auto;padding:1.25rem 1rem 3rem}
.eyebrow{margin:.5rem 0 0;color:var(--muted);font-size:.875rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
h1{font-size:1.625rem;line-height:1.2;margin:.25rem 0 .75rem}
p{margin:.5rem 0}
code{font:0.875em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
fieldset{border:0;margin:1.25rem 0 0;padding:0;min-width:0}
legend{font-weight:700;padding:0;margin-bottom:.5rem}
.personas{display:grid;gap:.5rem}
.persona{position:relative;display:flex;align-items:center;gap:.75rem;padding:.75rem;border:1px solid var(--line);border-radius:.75rem;background:var(--card)}
.persona:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.persona input{position:relative;z-index:1;width:1.25rem;height:1.25rem;margin:0;flex:none;accent-color:var(--accent)}
.persona label{display:grid;cursor:pointer}
.persona label::after{content:"";position:absolute;inset:0;border-radius:.75rem}
.avatar{flex:none;width:2.5rem;height:2.5rem;border-radius:50%;display:grid;place-items:center;background:var(--accent);color:var(--accent-fg);font-weight:700}
.who{display:grid;min-width:0;flex:1}
.who strong,.who label span{overflow-wrap:anywhere}
.who label span{color:var(--muted);font-size:.875rem}
.about{display:block;color:var(--muted);font-size:.875rem;margin-top:.25rem}
.tags{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.25rem}
.tag{font-size:.75rem;border:1px solid var(--line);border-radius:999px;padding:0 .5rem;color:var(--muted)}
.other{display:grid;gap:.5rem;margin-top:.75rem;padding:.75rem;border:1px dashed var(--line);border-radius:.75rem}
form:has(#persona-email:not(:checked)) .other{display:none}
label.field{display:grid;gap:.25rem;font-weight:600}
input[type=email],input[type=text]{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.6rem .7rem;min-height:44px;width:100%}
.check{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
.check input{margin-top:.3rem;accent-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.25rem}
button{font:inherit;font-weight:600;min-height:44px;padding:.6rem 1.2rem;border-radius:.6rem;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
details{margin-top:1.5rem;border:1px solid var(--line);border-radius:.75rem;padding:.5rem .75rem;background:var(--card)}
summary{cursor:pointer;font-weight:600;padding:.6rem 0}
.faults{display:grid;gap:.5rem;margin-top:1rem}
.faults legend{font-size:.875rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.faults small{display:block;color:var(--muted)}
.error{color:var(--error);font-weight:600}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem .75rem;margin:2rem 0 0;font-size:.875rem;color:var(--muted)}
dt{font-weight:600}
dd{margin:0;overflow-wrap:anywhere}
@media (max-width:30rem){dl{grid-template-columns:1fr}dd{margin-bottom:.5rem}.banner{font-size:.8125rem;letter-spacing:0}}
@media (prefers-reduced-motion:no-preference){.persona{transition:border-color .15s}}
`;

interface Layout {
  title: string;
  nonce: string;
  body: Html;
}

function layout({ title, nonce, body }: Layout): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title} · Development only</title>
<style nonce="${nonce}">${new Html(STYLE)}</style>
</head>
<body>
<div class="banner" role="note"><span>DEVELOPMENT ONLY · not a real sign-in</span></div>
<main>
${body}
</main>
</body>
</html>
`.value;
}

/** A Content-Security-Policy for one page: nothing loads, forms post only where listed. */
export function pageCsp(nonce: string, formAction: readonly string[], script = false): string {
  const action = formAction.length > 0 ? formAction.join(" ") : "'none'";
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    script ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
    `form-action ${action}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function newNonce(): string {
  return randomToken(16);
}

// --- Sign-in page ------------------------------------------------------------------------------

export interface PickerPersona {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean | null;
  description: string | null;
  roles: readonly string[];
  signedIn: boolean;
}

export interface PickerPage {
  nonce: string;
  action: string;
  transaction: string;
  issuer: string;
  standsInFor: string;
  clientName: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  personas: readonly PickerPersona[];
  /** The persona preselected; null selects "another email address". */
  selected: string | null;
  emailHint: string;
  faultPicker: boolean;
  faultsAvailable: (name: FaultName) => boolean;
  firstAuthorisationChoice: boolean;
  error: string | null;
  reauthentication: boolean;
}

function initials(name: string | null, email: string | null): string {
  const source = name ?? email ?? "?";
  const letters = source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

function personaOption(persona: PickerPersona, checked: boolean, index: number): Html {
  const id = `persona-${index}`;
  const tags: Html[] = [];
  if (persona.signedIn) tags.push(html`<span class="tag">signed in</span>`);
  if (persona.email === null) tags.push(html`<span class="tag">no email</span>`);
  else if (persona.emailVerified === false)
    tags.push(html`<span class="tag">email not verified</span>`);
  else tags.push(html`<span class="tag">email verified</span>`);
  for (const role of persona.roles) tags.push(html`<span class="tag">role: ${role}</span>`);
  return html`<div class="persona">
<input type="radio" name="persona" id="${id}" value="${persona.id}"${checked ? new Html(" checked") : ""} aria-describedby="${id}-about">
<span class="avatar" aria-hidden="true">${initials(persona.name, persona.email)}</span>
<div class="who"><label for="${id}"><strong>${persona.name ?? "(no name)"}</strong><span>${persona.email ?? "no email address"}</span></label><div id="${id}-about">${persona.description ? html`<span class="about">${persona.description}</span>` : ""}<span class="tags">${tags}</span></div></div>
</div>`;
}

const FAULT_GROUPS: ReadonlyArray<[string, readonly FaultScope[]]> = [
  ["Token signature and validity", ["token"]],
  ["ID token claims", ["id_token"]],
  ["Identity asserted", ["identity"]],
  ["Token response", ["response"]],
  ["Authorisation response", ["authorization"]],
];

function faultFieldset(page: PickerPage): Html {
  const groups = FAULT_GROUPS.map(([legend, scopes]) => {
    const items = FAULT_NAMES.filter(
      (name) =>
        isFlowFault(name) &&
        page.faultsAvailable(name) &&
        scopes.includes(FAULT_CATALOGUE[name].scope),
    ).map((name) => {
      const fault = FAULT_CATALOGUE[name];
      return html`<label class="check"><input type="checkbox" name="fault" value="${name}"><span>${fault.label}<small>${fault.provider}</small></span></label>`;
    });
    return html`<fieldset class="faults"><legend>${legend}</legend>${items}</fieldset>`;
  });
  return html`<details>
<summary>Inject a fault (testing a relying party)</summary>
<p>Each fault makes this one sign-in misbehave the way named; a correct application must reject it.</p>
${groups}
</details>`;
}

export function renderPicker(page: PickerPage): string {
  const selected = page.selected;
  const redirectOrigin = new URL(page.redirectUri).origin;
  const body = html`<p class="eyebrow">Stands in for ${page.standsInFor}</p>
<h1>Development sign-in</h1>
<p><strong>${page.clientName}</strong> asked to sign you in${page.reauthentication ? " again" : ""}. Nothing here is a real account and no password is asked: choose a test persona. You will return to <code>${redirectOrigin}</code>.</p>
${page.error ? html`<p class="error" role="alert">${page.error}</p>` : ""}
<form method="post" action="${page.action}" data-dev-idp="sign-in">
<input type="hidden" name="txn" value="${page.transaction}">
<fieldset class="personas"><legend>Test personas</legend>
${page.personas.map((persona, index) => personaOption(persona, persona.id === selected, index))}
<div class="persona">
<input type="radio" name="persona" id="persona-email" value="__email__"${selected === null ? new Html(" checked") : ""} aria-controls="other-email">
<span class="avatar" aria-hidden="true">+</span>
<div class="who"><label for="persona-email"><strong>Use another email address</strong><span>Creates a persona for the address you type</span></label></div>
</div>
</fieldset>
<fieldset class="other" id="other-email"><legend>Another email address</legend>
<label class="field" for="email">Email<input id="email" name="email" type="email" maxlength="254" autocomplete="off" spellcheck="false" value="${page.emailHint}"></label>
<label class="field" for="name">Name (optional)<input id="name" name="name" type="text" maxlength="100" autocomplete="off"></label>
<label class="check"><input type="checkbox" name="email_verified" value="true" checked><span>The provider says this email is verified</span></label>
</fieldset>
${page.firstAuthorisationChoice ? html`<fieldset><legend>Apple behaviour</legend><label class="check"><input type="checkbox" name="first_authorisation" value="true"><span>Treat this as the first time this persona authorises the app (Apple sends the name only then)</span></label></fieldset>` : ""}
${page.faultPicker ? faultFieldset(page) : ""}
<div class="actions">
<button type="submit" class="primary" name="action" value="continue">Continue</button>
<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
</div>
</form>
<dl>
<dt>Issuer</dt><dd><code>${page.issuer}</code></dd>
<dt>Client</dt><dd><code>${page.clientId}</code></dd>
<dt>Redirect URI</dt><dd><code>${page.redirectUri}</code></dd>
<dt>Scopes</dt><dd><code>${page.scopes.join(" ")}</code></dd>
</dl>`;
  return layout({ title: "Development sign-in", nonce: page.nonce, body });
}

// --- form_post -------------------------------------------------------------------------------

/** OAuth 2.0 Form Post Response Mode: an auto-submitting form, with a button when scripts are off. */
export function renderFormPost(
  nonce: string,
  action: string,
  fields: Record<string, string>,
): string {
  const inputs = Object.entries(fields).map(
    ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
  );
  const body = html`<h1>Returning to the application</h1>
<form method="post" action="${action}" id="form-post" data-dev-idp="form-post">
${inputs}
<noscript><p>Scripts are off: continue manually.</p></noscript>
<div class="actions"><button type="submit" class="primary">Continue</button></div>
</form>
<script nonce="${nonce}">document.getElementById("form-post").submit();</script>`;
  return layout({ title: "Returning to the application", nonce, body });
}

// --- Errors and sign-out -----------------------------------------------------------------------

export function renderError(
  nonce: string,
  title: string,
  message: string,
  detail?: string,
): string {
  const body = html`<h1>${title}</h1>
<p>${message}</p>
${detail ? html`<p><code>${detail}</code></p>` : ""}
<p>This page belongs to the development issuer. Return to the application and start again.</p>`;
  return layout({ title, nonce, body });
}

export function renderLogoutConfirm(nonce: string, action: string, transaction: string): string {
  const body = html`<h1>Sign out of the development issuer?</h1>
<p>An application asked to end your session with this development issuer.</p>
<form method="post" action="${action}" data-dev-idp="logout">
<input type="hidden" name="txn" value="${transaction}">
<div class="actions"><button type="submit" class="primary" name="action" value="logout">Sign out</button></div>
</form>`;
  return layout({ title: "Sign out", nonce, body });
}

export function renderSignedOut(nonce: string): string {
  const body = html`<h1>Signed out</h1>
<p>Your session with the development issuer has ended. You can close this page.</p>`;
  return layout({ title: "Signed out", nonce, body });
}
