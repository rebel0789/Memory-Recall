import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODE_INTELLIGENCE_TIER_1_LANGUAGES = Object.freeze([
  'typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go',
  'rust', 'php', 'ruby', 'swift', 'c', 'cpp', 'dart'
]);

export const CODE_INTELLIGENCE_TIER_2_LANGUAGES = Object.freeze([
  'lua', 'bash', 'sql', 'objective-c', 'scala', 'r', 'julia', 'zig'
]);

export const CODE_INTELLIGENCE_CAPABILITIES = Object.freeze([
  'parse', 'structure', 'imports', 'exports', 'heritage', 'types',
  'calls', 'config', 'frameworks', 'impact', 'processes'
]);

const EXPECTED_TIER = new Map([
  ...CODE_INTELLIGENCE_TIER_1_LANGUAGES.map((language) => [language, 1]),
  ...CODE_INTELLIGENCE_TIER_2_LANGUAGES.map((language) => [language, 2])
]);
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/u;

function finding(code, language = null, capability = null, evidencePath = null) {
  return { code, language, capability, path: evidencePath };
}

function resolveRoot(root) {
  return path.resolve(root instanceof URL ? fileURLToPath(root) : String(root));
}

async function evidencePathExists(repositoryRoot, evidencePath) {
  if (typeof evidencePath !== 'string' || !evidencePath) return false;
  if (path.isAbsolute(evidencePath) || WINDOWS_ABSOLUTE_PATH_RE.test(evidencePath)) return false;
  const resolved = path.resolve(repositoryRoot, evidencePath);
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) return false;
  try {
    await access(resolved);
    return true;
  } catch {
    return false;
  }
}

export async function auditCodeIntelligenceCapabilityMatrix(matrix, { root = process.cwd() } = {}) {
  const findings = [];
  const repositoryRoot = resolveRoot(root);
  const languages = Array.isArray(matrix?.languages) ? matrix.languages : [];
  const seen = new Set();

  for (const item of languages) {
    const language = typeof item?.id === 'string' ? item.id : null;
    if (!language || !EXPECTED_TIER.has(language)) {
      findings.push(finding('unknown_language', language));
      continue;
    }
    if (seen.has(language)) findings.push(finding('duplicate_language', language));
    seen.add(language);
    if (item.tier !== EXPECTED_TIER.get(language)) findings.push(finding('language_tier_mismatch', language));

    for (const capability of CODE_INTELLIGENCE_CAPABILITIES) {
      const claim = item.capabilities?.[capability];
      if (!claim) {
        findings.push(finding('missing_capability', language, capability));
        continue;
      }
      const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
      const evidenceClasses = new Set(evidence.map((entry) => entry?.class));
      if (claim.benchmarkStatus === 'meets-floor') {
        if (!evidenceClasses.has('fixture')) findings.push(finding('full_claim_missing_fixture_evidence', language, capability));
        if (!evidenceClasses.has('real-repo')) findings.push(finding('full_claim_missing_real_repo_evidence', language, capability));
      }
      for (const entry of evidence) {
        const evidencePath = entry?.path;
        if (typeof evidencePath !== 'string' || !evidencePath) {
          findings.push(finding('evidence_path_missing', language, capability));
          continue;
        }
        if (path.isAbsolute(evidencePath) || WINDOWS_ABSOLUTE_PATH_RE.test(evidencePath)) {
          findings.push(finding('evidence_path_absolute', language, capability, evidencePath));
          continue;
        }
        const resolved = path.resolve(repositoryRoot, evidencePath);
        if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
          findings.push(finding('evidence_path_escape', language, capability, evidencePath));
          continue;
        }
        if (!await evidencePathExists(repositoryRoot, evidencePath)) {
          findings.push(finding('evidence_path_not_found', language, capability, evidencePath));
        }
      }
    }
  }

  for (const language of EXPECTED_TIER.keys()) {
    if (!seen.has(language)) findings.push(finding('missing_language', language));
  }
  return findings;
}
