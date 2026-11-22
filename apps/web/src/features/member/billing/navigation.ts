/**
 * Leave the app for the payment provider's hosted page (a full navigation: the provider's page
 * is not part of the app). One function, so component tests can stand in for the provider.
 */
export function leaveFor(href: string): void {
  window.location.assign(href);
}
