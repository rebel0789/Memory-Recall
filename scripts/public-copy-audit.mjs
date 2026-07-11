const OAF_URI = /oaf:\/\//u;
const COMPATIBILITY_EXPLANATION = /oaf-compatibility\.md|Legacy OAF identifiers|OAF compatibility/iu;
const COMPATIBILITY_WINDOW_CHARS = 1200;

function hasNearbyCompatibilityExplanation(text, index) {
  const start = Math.max(0, index - COMPATIBILITY_WINDOW_CHARS);
  const end = Math.min(text.length, index + COMPATIBILITY_WINDOW_CHARS);
  return COMPATIBILITY_EXPLANATION.test(text.slice(start, end));
}

function rendersCompatibilityNoteWithCommandList(entry) {
  return entry.relative === 'apps/web/app.js' && /function contextPackCommandList\([\s\S]{0,1200}includes\('oaf:\/\/'\)[\s\S]{0,1200}OAF_URI_COMPATIBILITY_NOTE[\s\S]{0,1200}OAF_COMPATIBILITY_URL/u.test(entry.text);
}

export function auditPublicCopyEntries(scopes) {
  const errors = [];
  for (const scope of scopes) {
    for (const entry of scope.entries ?? []) {
      if (!OAF_URI.test(entry.text)) continue;
      const appRendersCompatibilityNote = rendersCompatibilityNoteWithCommandList(entry);
      for (const match of entry.text.matchAll(/oaf:\/\//gu)) {
        const index = match.index ?? 0;
        if (!hasNearbyCompatibilityExplanation(entry.text, index) && !appRendersCompatibilityNote) {
          errors.push(`${entry.relative}: oaf:// appears in public copy without a nearby compatibility link`);
        }
      }
    }
  }
  return errors;
}
