// The build identifier shown in the corner of every screen (defined at build time from public/build-id.txt; "dev" outside a build).
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev';
export function showBuildId(doc = document) {
  let el = doc.getElementById('buildId');
  if (!el) { el = doc.createElement('div'); el.id = 'buildId'; el.style.cssText = 'position:fixed;right:6px;bottom:4px;font-size:10px;opacity:.55;pointer-events:none;z-index:9999;'; doc.body.appendChild(el); }
  el.textContent = 'Build ' + BUILD_ID;
  return el;
}
