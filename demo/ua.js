// Diagnostic browser label for the demo pages, built from User-Agent Client Hints
// when they exist. The raw navigator.userAgent string is only a fallback: it carries
// full build and device noise that a status line or benchmark metadata never needs.
const grease = /not.?a.?brand/i;

export function browserLabel(nav = navigator) {
  const hints = nav.userAgentData;
  if (!hints?.brands?.length || !hints.platform) return nav.userAgent;
  const real = hints.brands.filter(brand => !grease.test(brand.brand));
  // Chromium is the generic engine entry; a fuller name (Google Chrome, Microsoft
  // Edge, …) identifies the actual browser, so prefer it when the list has one.
  const named = real.filter(brand => brand.brand !== 'Chromium');
  const brand = named[named.length - 1] || real[real.length - 1];
  return brand ? `${brand.brand} ${brand.version} on ${hints.platform}` : nav.userAgent;
}
