import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, hashRef, stableStringify, terms } from '../../../../packages/context-compiler/src/index.mjs';

export const AST_CODE_PROVIDER_VERSION = '1.0.0';
export const AST_CODE_PARSER_VERSION = 'oaf-js-ts-static-1.0.0';

const SOURCE_ID = 'provider:native:context-candidate:ast-code';
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'out', 'vendor']);
const DEFAULT_MAX_FILE_BYTES = 128 * 1024;
const DEFAULT_MAX_FILES = 200;
const CONTROL_FLOW_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);
const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'of', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield'
]);

export function createNativeAstCodeCandidateSource({
  root = null,
  workspaceId = 'ws_local',
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  clock = () => new Date().toISOString()
} = {}) {
  return Object.freeze({
    descriptor: () => ({
      schemaVersion: '1.0.0',
      id: SOURCE_ID,
      kind: 'ast-code',
      version: AST_CODE_PROVIDER_VERSION,
      enabled: true,
      methods: ['js_ts_static_chunk'],
      contractVersion: '1.0.0',
      description: 'Workspace-scoped dependency-free JS/TS static code chunk candidate source'
    }),
    health: async () => ({ status: 'healthy' }),
    async query(request, trustedContext = {}) {
      const workspaceRoot = root ?? trustedContext.workspaceRoot;
      if (!workspaceRoot) return { candidates: [] };
      const scan = await scanAstCodeWorkspace({
        root: workspaceRoot,
        workspaceId: request.workspaceId ?? workspaceId,
        maxFileBytes,
        maxFiles,
        clock
      });
      const queryText = [
        request.objective,
        request.step,
        ...(request.requiredEntities ?? [])
      ].filter(Boolean).join(' ');
      const scored = scan.chunks
        .map((chunk) => ({ chunk, score: overlapScore(queryText, chunkSearchText(chunk)) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.chunk.locator.localeCompare(b.chunk.locator))
        .slice(0, trustedContext.sourceLimit ?? request.perSourceLimit ?? 10);
      return {
        candidates: scored.map(({ chunk, score }, index) => ({
          record: recordFromChunk(chunk, request.workspaceId ?? workspaceId),
          sourceHit: {
            sourceId: SOURCE_ID,
            sourceKind: 'ast-code',
            sourceVersion: AST_CODE_PROVIDER_VERSION,
            retrievalMethod: 'js_ts_static_chunk',
            localRank: index + 1,
            localScore: Number(Math.max(0, Math.min(1, score)).toFixed(6)),
            reasonCodes: ['ast_code_match'],
            queryFingerprint: trustedContext.queryFingerprint ?? hashRef(stableStringify({ queryText })),
            accessDecisionRef: trustedContext.accessDecisionRef ?? 'poldet_unconfigured',
            retrievedAt: trustedContext.retrievedAt ?? clock()
          }
        }))
      };
    }
  });
}

export async function scanAstCodeWorkspace({
  root,
  workspaceId = 'ws_local',
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  const rootReal = await realpath(root);
  const diagnostics = [];
  const chunks = [];
  const fileOutlines = [];
  let visitedFiles = 0;

  async function walk(relativeDirectory = '') {
    if (visitedFiles >= maxFiles) return;
    const absoluteDirectory = path.join(rootReal, relativeDirectory);
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visitedFiles >= maxFiles) return;
      const relativePath = normalizeRelative(path.join(relativeDirectory, entry.name));
      const absolutePath = path.join(rootReal, relativePath);
      const locator = locatorFor(relativePath);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        diagnostics.push(diagnostic(locator, 'symlink_skipped'));
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await walk(relativePath);
        continue;
      }
      if (!info.isFile() || !EXTENSIONS.has(path.extname(entry.name))) continue;
      const fileReal = await realpath(absolutePath);
      if (!insideRoot(rootReal, fileReal)) {
        diagnostics.push(diagnostic(locator, 'path_escape_skipped'));
        continue;
      }
      const size = info.size ?? (await stat(fileReal)).size;
      if (size > maxFileBytes) {
        diagnostics.push(diagnostic(locator, 'file_too_large'));
        continue;
      }
      visitedFiles += 1;
      const body = await readFile(fileReal, 'utf8');
      const collectedAt = clock();
      const fileChunks = chunksForFile({ relativePath, body, workspaceId, collectedAt });
      chunks.push(...fileChunks);
      fileOutlines.push(fileOutlineFor({ relativePath, body, workspaceId, collectedAt, chunks: fileChunks }));
    }
  }

  await walk();
  const sortedChunks = chunks.sort((a, b) => a.locator.localeCompare(b.locator));
  const sortedFileOutlines = fileOutlines.sort((a, b) => a.locator.localeCompare(b.locator));
  const symbolIndex = buildSymbolIndex({ workspaceId, chunks: sortedChunks, fileOutlines: sortedFileOutlines, indexedAt: clock() });
  const result = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion: AST_CODE_PARSER_VERSION,
    fileCount: visitedFiles,
    chunkCount: sortedChunks.length,
    chunks: sortedChunks,
    fileOutlines: sortedFileOutlines,
    repositoryOutline: repositoryOutlineFor({ workspaceId, fileOutlines: sortedFileOutlines, symbolIndex }),
    contentJournal: sortedFileOutlines.map((file) => ({
      locator: file.locator,
      contentHash: file.contentHash,
      symbolFingerprint: file.symbolFingerprint,
      collectedAt: file.collectedAt
    })),
    symbolIndex,
    diagnostics: diagnostics.sort((a, b) => a.locator.localeCompare(b.locator) || a.code.localeCompare(b.code))
  };
  return Object.freeze({ ...result, scanFingerprint: contentFingerprint(result) });
}

export async function buildJsTsSourceIndex(options = {}) {
  const scan = await scanAstCodeWorkspace(options);
  return Object.freeze({
    schemaVersion: '1.0.0',
    workspaceId: scan.workspaceId,
    parserVersion: scan.parserVersion,
    scanFingerprint: scan.scanFingerprint,
    repositoryOutline: scan.repositoryOutline,
    fileOutlines: scan.fileOutlines,
    contentJournal: scan.contentJournal,
    symbolIndex: scan.symbolIndex,
    diagnostics: scan.diagnostics,
    sourceIndexFingerprint: contentFingerprint({
      repositoryOutline: scan.repositoryOutline,
      fileOutlines: scan.fileOutlines,
      contentJournal: scan.contentJournal,
      symbolIndex: scan.symbolIndex,
      diagnostics: scan.diagnostics
    })
  });
}

export function querySourceIndex(index, { operation, name = null, module = null, locator = null } = {}) {
  if (!index?.symbolIndex) throw new Error('source index is required');
  const symbols = index.symbolIndex.symbols ?? [];
  const references = index.symbolIndex.references ?? [];
  const imports = index.symbolIndex.imports ?? [];
  const exports = index.symbolIndex.exports ?? [];
  const callEdges = index.symbolIndex.callEdges ?? [];
  const normalizedName = name ? safeTag(name) : null;
  const normalizedModule = module ? String(module) : null;
  switch (operation) {
    case 'definition':
    case 'declaration':
    case 'symbol-source':
      return symbols.filter((symbol) => !normalizedName || safeTag(symbol.name) === normalizedName);
    case 'references':
      return references.filter((reference) => !normalizedName || safeTag(reference.targetName) === normalizedName);
    case 'imports':
      return imports.filter((item) => !normalizedModule || item.module === normalizedModule);
    case 'exports':
      return exports.filter((item) => !normalizedName || safeTag(item.name) === normalizedName);
    case 'callers':
      return callEdges.filter((edge) => !normalizedName || safeTag(edge.calleeName) === normalizedName);
    case 'callees':
      return callEdges.filter((edge) => !normalizedName || safeTag(edge.callerName) === normalizedName);
    case 'file-outline':
      return (index.fileOutlines ?? []).filter((file) => !locator || file.locator === locator);
    case 'repository-outline':
      return index.repositoryOutline;
    default:
      throw new Error(`unsupported_source_index_operation:${operation}`);
  }
}

export async function readAstCodeSlice({ root, chunk } = {}) {
  // Internal verification helper: provider query/protocol outputs expose only hashes and locators.
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  if (!chunk?.locator || !chunk?.byteRange) throw new Error('chunk locator and byteRange are required');
  const rootReal = await realpath(root);
  const relativePath = relativeFromLocator(chunk.locator);
  const absolutePath = path.join(rootReal, relativePath);
  const fileReal = await realpath(absolutePath);
  if (!insideRoot(rootReal, fileReal)) throw new Error('ast_code_slice_outside_workspace');
  const buffer = await readFile(fileReal);
  return buffer.subarray(chunk.byteRange.start, chunk.byteRange.end).toString('utf8');
}

function chunksForFile({ relativePath, body, workspaceId, collectedAt }) {
  const language = languageFor(relativePath);
  const fileImports = importsFor(body).sort((a, b) => a.module.localeCompare(b.module));
  const lines = body.split('\n');
  const lineStartBytes = lineByteStarts(lines);
  const declarations = declarationsFor(lines);
  const chunks = [];
  for (const declaration of declarations) {
    const endLine = declarationEndLine(lines, declaration.startLine);
    const sourceSlice = lines.slice(declaration.startLine, endLine + 1).join('\n');
    const parseErrorState = bracesBalanced(sourceSlice) ? 'none' : 'unbalanced_braces';
    const lineRange = { start: declaration.startLine + 1, end: endLine + 1 };
    const byteRange = {
      start: lineStartBytes[declaration.startLine],
      end: lineStartBytes[endLine] + Buffer.byteLength(lines[endLine] ?? '', 'utf8')
    };
    const entities = entitiesForDeclaration(declaration, sourceSlice);
    const signature = signatureFor(declaration, sourceSlice);
    const calls = declaration.kind === 'class' ? [] : callsForDeclaration(declaration, sourceSlice).map((name) => ({ name, callHash: hashRef(`${relativePath}:${lineRange.start}:${name}`) }));
    const references = referencesForSource(sourceSlice).map((name) => ({ name, referenceHash: hashRef(`${relativePath}:${lineRange.start}:${name}`) }));
    const imports = declaration.kind === 'class' ? [] : importsForSlice(fileImports, sourceSlice).map(publicImport);
    const exports = declaration.exported ? [{ name: declaration.name, kind: declaration.kind, exportHash: hashRef(`${relativePath}:${declaration.name}:export`) }] : [];
    const chunk = {
      schemaVersion: '1.0.0',
      id: `astchunk_${sha256(`${relativePath}:${lineRange.start}:${lineRange.end}:${sourceSlice}`).slice(0, 32)}`,
      workspaceId,
      language,
      locator: `${locatorFor(relativePath)}#L${lineRange.start}-L${lineRange.end}`,
      parserVersion: AST_CODE_PARSER_VERSION,
      parseErrorState,
      byteRange,
      lineRange,
      scopeChain: declaration.scopeChain,
      entities,
      imports,
      exports,
      signatureHash: hashRef(signature),
      siblingLocators: [],
      sourceSnapshotId: `srcsnap_${sha256(`${relativePath}:${hashRef(body)}`).slice(0, 16)}`,
      exactSourceReconstructionHash: hashRef(sourceSlice),
      contentHash: hashRef(sourceSlice),
      calls,
      references,
      collectedAt
    };
    chunks.push(chunk);
  }
  return chunks.map((chunk, index) => {
    const siblingLocators = [chunks[index - 1]?.locator, chunks[index + 1]?.locator].filter(Boolean);
    const withSiblings = { ...chunk, siblingLocators };
    return Object.freeze({ ...withSiblings, chunkFingerprint: contentFingerprint(withSiblings) });
  });
}

function declarationsFor(lines) {
  const declarations = [];
  const scopeStack = [];
  let braceDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    while (scopeStack.length && braceDepth < scopeStack[scopeStack.length - 1].depth) scopeStack.pop();
    const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u);
    const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u);
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u);
    const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u);
    const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/u);
    const methodMatch = scopeStack.length ? trimmed.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/u) : null;
    const exported = /^export\s+/u.test(trimmed);
    if (classMatch) {
      declarations.push({ kind: 'class', name: classMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
      scopeStack.push({ name: classMatch[1], depth: braceDepth + Math.max(1, braceDelta(raw)) });
    } else if (functionMatch) {
      declarations.push({ kind: 'function', name: functionMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (arrowMatch) {
      declarations.push({ kind: 'function', name: arrowMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (interfaceMatch) {
      declarations.push({ kind: 'interface', name: interfaceMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (typeMatch) {
      declarations.push({ kind: 'type', name: typeMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported });
    } else if (methodMatch && !CONTROL_FLOW_NAMES.has(methodMatch[1])) {
      declarations.push({ kind: 'method', name: methodMatch[1], startLine: index, scopeChain: scopeStack.map((item) => item.name), exported: false });
    }
    braceDepth += braceDelta(raw);
  }
  return declarations;
}

function entitiesForDeclaration(declaration, sourceSlice) {
  const entities = [{ kind: declaration.kind, name: declaration.name }];
  if (declaration.kind === 'class') {
    const methodMatches = sourceSlice.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gmu);
    for (const match of methodMatches) {
      if (!CONTROL_FLOW_NAMES.has(match[1])) entities.push({ kind: 'method', name: match[1] });
    }
  }
  return Object.freeze(entities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
}

function declarationEndLine(lines, startLine) {
  let depth = 0;
  let sawBrace = false;
  for (let index = startLine; index < lines.length; index += 1) {
    const delta = braceDelta(lines[index]);
    if (lines[index].includes('{')) sawBrace = true;
    depth += delta;
    if (sawBrace && depth <= 0) return index;
    if (!sawBrace && /;\s*$/u.test(lines[index].trim())) return index;
  }
  return lines.length - 1;
}

function importsFor(body) {
  const imports = [];
  for (const line of body.split('\n')) {
    const fromMatch = line.match(/^\s*import(?:\s+type)?\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/u);
    const bareMatch = line.match(/^\s*import\s+['"]([^'"]+)['"]/u);
    const requireMatch = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/u);
    const requireName = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u)?.[1] ?? null;
    const rawModule = fromMatch?.[2] ?? bareMatch?.[1] ?? requireMatch?.[1] ?? null;
    if (rawModule) {
      const module = sanitizeModuleSpecifier(rawModule);
      imports.push({
        module,
        importHash: hashRef(rawModule),
        names: fromMatch ? importedNames(fromMatch[1]) : requireName ? [requireName] : []
      });
    }
  }
  return uniqueBy(imports, (item) => item.module);
}

function fileOutlineFor({ relativePath, body, workspaceId, collectedAt, chunks }) {
  const imports = importsFor(body).sort((a, b) => a.module.localeCompare(b.module));
  const exports = exportsFor({ body, chunks }).sort((a, b) => a.name.localeCompare(b.name));
  const contentHash = hashRef(body);
  const outline = {
    schemaVersion: '1.0.0',
    workspaceId,
    locator: locatorFor(relativePath),
    language: languageFor(relativePath),
    contentHash,
    sourceSnapshotId: `srcsnap_${sha256(`${relativePath}:${contentHash}`).slice(0, 16)}`,
    lineCount: body.split('\n').length,
    chunkIds: chunks.map((chunk) => chunk.id).sort(),
    symbols: chunks.flatMap((chunk) => chunk.entities.map((entity) => ({
      name: entity.name,
      kind: entity.kind,
      locator: chunk.locator,
      signatureHash: chunk.signatureHash
    }))).sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind)),
    imports: imports.map(publicImport),
    exports,
    collectedAt
  };
  return Object.freeze({ ...outline, symbolFingerprint: contentFingerprint(outline) });
}

function repositoryOutlineFor({ workspaceId, fileOutlines, symbolIndex }) {
  const outline = {
    schemaVersion: '1.0.0',
    workspaceId,
    fileCount: fileOutlines.length,
    symbolCount: symbolIndex.symbols.length,
    importCount: symbolIndex.imports.length,
    exportCount: symbolIndex.exports.length,
    callEdgeCount: symbolIndex.callEdges.length,
    locators: fileOutlines.map((file) => file.locator).sort(),
    languages: [...new Set(fileOutlines.map((file) => file.language))].sort()
  };
  return Object.freeze({ ...outline, outlineFingerprint: hashRef(stableStringify(outline)) });
}

function buildSymbolIndex({ workspaceId, chunks, fileOutlines, indexedAt }) {
  const symbols = [];
  const imports = [];
  const exports = [];
  const references = [];
  const callEdges = [];
  const symbolsByName = new Map();
  for (const chunk of chunks) {
    for (const entity of chunk.entities) {
      const symbol = {
        id: `symbol_${sha256(`${chunk.locator}:${entity.kind}:${entity.name}`).slice(0, 32)}`,
        workspaceId,
        name: entity.name,
        kind: entity.kind,
        locator: chunk.locator,
        chunkId: chunk.id,
        scopeChain: chunk.scopeChain,
        signatureHash: chunk.signatureHash,
        contentHash: chunk.contentHash,
        sourceSnapshotId: chunk.sourceSnapshotId
      };
      symbols.push(symbol);
      const values = symbolsByName.get(entity.name) ?? [];
      values.push(symbol);
      symbolsByName.set(entity.name, values);
    }
    for (const item of chunk.imports) imports.push({
      id: `import_${sha256(`${chunk.locator}:${item.module}`).slice(0, 32)}`,
      workspaceId,
      module: item.module,
      moduleHash: item.importHash,
      locator: chunk.locator,
      chunkId: chunk.id
    });
    for (const item of chunk.exports ?? []) {
      exports.push({
        id: `export_${sha256(`${chunk.locator}:${item.name}`).slice(0, 32)}`,
        workspaceId,
        name: item.name,
        kind: item.kind,
        locator: chunk.locator,
        chunkId: chunk.id,
        exportHash: item.exportHash
      });
    }
  }

  for (const chunk of chunks) {
    const caller = chunk.entities.find((entity) => ['function', 'method'].includes(entity.kind)) ?? chunk.entities[0];
    for (const reference of chunk.references ?? []) {
      if (!symbolsByName.has(reference.name)) continue;
      for (const target of symbolsByName.get(reference.name)) {
        if (target.chunkId === chunk.id && target.name === caller?.name) continue;
        references.push({
          id: `ref_${sha256(`${chunk.locator}:${reference.name}:${target.id}`).slice(0, 32)}`,
          workspaceId,
          targetSymbolId: target.id,
          targetName: target.name,
          sourceLocator: chunk.locator,
          sourceChunkId: chunk.id,
          referenceHash: reference.referenceHash
        });
      }
    }
    if (!caller) continue;
    const callerSymbol = symbols.find((symbol) => symbol.chunkId === chunk.id && symbol.name === caller.name);
    if (!callerSymbol) continue;
    for (const call of chunk.calls ?? []) {
      if (!symbolsByName.has(call.name)) continue;
      for (const callee of symbolsByName.get(call.name)) {
        if (callee.id === callerSymbol.id) continue;
        callEdges.push({
          id: `call_${sha256(`${callerSymbol.id}:${callee.id}:${chunk.locator}`).slice(0, 32)}`,
          workspaceId,
          callerSymbolId: callerSymbol.id,
          callerName: callerSymbol.name,
          calleeSymbolId: callee.id,
          calleeName: callee.name,
          sourceLocator: chunk.locator,
          callHash: call.callHash
        });
      }
    }
  }

  const index = {
    schemaVersion: '1.0.0',
    workspaceId,
    parserVersion: AST_CODE_PARSER_VERSION,
    indexedAt,
    symbols: uniqueObjects(symbols, 'id').sort(byId),
    references: uniqueObjects(references, 'id').sort(byId),
    imports: uniqueObjects(imports, 'id').sort(byId),
    exports: uniqueObjects(exports, 'id').sort(byId),
    callEdges: uniqueObjects(callEdges, 'id').sort(byId),
    fileLocators: fileOutlines.map((file) => file.locator).sort()
  };
  return Object.freeze({ ...index, symbolIndexFingerprint: contentFingerprint(index) });
}

function exportsFor({ body, chunks }) {
  const output = [];
  for (const chunk of chunks) output.push(...(chunk.exports ?? []));
  for (const match of body.matchAll(/^\s*export\s+\{([^}]+)\}/gmu)) {
    for (const value of match[1].split(',')) {
      const name = value.trim().split(/\s+as\s+/u).pop()?.trim();
      if (name) output.push({ name, kind: 'export', exportHash: hashRef(`export:${name}`) });
    }
  }
  return uniqueBy(output, (item) => `${item.kind}:${item.name}`);
}

function signatureFor(declaration, sourceSlice) {
  const line = sourceSlice.split('\n')[0] ?? declaration.name;
  return stripStringsAndComments(line).replace(/\{.*$/u, '').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function referencesForSource(sourceSlice) {
  const names = [];
  for (const match of stripStringsAndComments(sourceSlice).matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
    if (!JS_KEYWORDS.has(match[0])) names.push(match[0]);
  }
  return [...new Set(names)].sort();
}

function callsForDeclaration(declaration, sourceSlice) {
  return callsForSource(sourceSlice).filter((name) => name !== declaration.name);
}

function callsForSource(sourceSlice) {
  const names = [];
  for (const match of stripStringsAndComments(sourceSlice).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (!JS_KEYWORDS.has(match[1])) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function importsForSlice(imports, sourceSlice) {
  const referenceTerms = referencesForSource(sourceSlice);
  const referenced = new Set(referenceTerms);
  return imports.filter((item) => !item.names.length || item.names.some((name) => referenced.has(name)));
}

function importedNames(specifier) {
  const value = String(specifier ?? '').trim();
  if (!value) return [];
  const names = [];
  const namespaceMatch = value.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/u);
  if (namespaceMatch) names.push(namespaceMatch[1]);
  const leading = value.split('{')[0].trim().replace(/^type\s+/u, '').split(',')[0].trim();
  if (leading && /^[A-Za-z_$][\w$]*$/u.test(leading)) names.push(leading);
  const named = value.match(/\{([^}]+)\}/u)?.[1] ?? '';
  for (const part of named.split(',')) {
    const cleaned = part.trim().replace(/^type\s+/u, '');
    if (!cleaned) continue;
    const alias = cleaned.split(/\s+as\s+/u).pop()?.trim();
    if (alias && /^[A-Za-z_$][\w$]*$/u.test(alias)) names.push(alias);
  }
  return [...new Set(names)].sort();
}

function publicImport(item) {
  return { module: item.module, importHash: item.importHash };
}

function sanitizeModuleSpecifier(rawModule) {
  const value = String(rawModule ?? '').trim();
  if (!value) return 'invalid-module';
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /(^|[\\/])(?:Users|private)([\\/]|$)/u.test(value) || /(^|[\\/])var[\\/]folders([\\/]|$)/u.test(value)) {
    return 'local:absolute-import';
  }
  return value.replace(/\s+/gu, ' ').slice(0, 240);
}

function contentFingerprint(value) {
  return hashRef(stableStringify(stripVolatileTimestamps(value)));
}

function stripVolatileTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripVolatileTimestamps);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (['collectedAt', 'indexedAt'].includes(key)) continue;
    output[key] = stripVolatileTimestamps(item);
  }
  return output;
}

function recordFromChunk(chunk, workspaceId) {
  const entityNames = chunk.entities.map((entity) => entity.name);
  const importNames = chunk.imports.map((item) => item.module);
  const text = [
    `Code chunk ${entityNames.join(' ')} in ${chunk.locator}.`,
    importNames.length ? `Imports ${importNames.join(' ')}.` : '',
    `Parse ${chunk.parseErrorState}.`
  ].filter(Boolean).join(' ');
  const tags = [
    'code',
    `language:${chunk.language}`,
    ...entityNames.map((name) => `symbol:${safeTag(name)}`),
    ...importNames.map((name) => `import:${safeTag(importAlias(name))}`)
  ].sort();
  return {
    id: `ast_${sha256(`${chunk.locator}:${chunk.contentHash}`).slice(0, 32)}`,
    version: chunk.chunkFingerprint,
    kind: 'code_chunk',
    workspaceId,
    text,
    tags,
    relations: tags,
    scope: 'workspace-private',
    dataClass: 'workspace-private',
    trustClass: 'observed',
    status: chunk.parseErrorState === 'none' ? 'active' : 'quarantined',
    source: chunk.locator,
    tokens: estimateTokens(text),
    confidence: chunk.parseErrorState === 'none' ? 0.82 : 0.25,
    authority: 0.55,
    updatedAt: chunk.collectedAt,
    contentHash: chunk.contentHash,
    metadata: {
      astCode: {
        parserVersion: chunk.parserVersion,
        parseErrorState: chunk.parseErrorState,
        byteRange: chunk.byteRange,
        lineRange: chunk.lineRange,
        scopeChain: chunk.scopeChain,
        entities: chunk.entities,
        imports: chunk.imports.map((item) => ({ moduleHash: item.importHash }))
      }
    }
  };
}

function chunkSearchText(chunk) {
  return [
    chunk.locator,
    chunk.language,
    chunk.parseErrorState,
    ...chunk.scopeChain,
    ...chunk.entities.map((entity) => `${entity.kind} ${entity.name} symbol:${entity.name}`),
    ...chunk.imports.map((item) => `${item.module} import:${importAlias(item.module)}`)
  ].join(' ');
}

function overlapScore(query, text) {
  const queryTerms = terms(query);
  const textTerms = terms(text);
  if (!queryTerms.size || !textTerms.size) return 0;
  let matches = 0;
  for (const term of queryTerms) if (textTerms.has(term)) matches += 1;
  return matches / Math.sqrt(queryTerms.size * textTerms.size);
}

function diagnostic(locator, code) {
  return Object.freeze({ locator, code });
}

function locatorFor(relativePath) {
  return `workspace://${normalizeRelative(relativePath)}`;
}

function relativeFromLocator(locator) {
  if (!locator.startsWith('workspace://')) throw new Error('ast_code_locator_invalid');
  const withoutScheme = locator.slice('workspace://'.length).split('#')[0];
  if (!withoutScheme || path.isAbsolute(withoutScheme) || withoutScheme.split('/').includes('..')) throw new Error('ast_code_locator_invalid');
  return withoutScheme;
}

function normalizeRelative(value) {
  return String(value).split(path.sep).join('/').replace(/^\/+/u, '');
}

function insideRoot(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lineByteStarts(lines) {
  const starts = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += Buffer.byteLength(lines[index] ?? '', 'utf8');
    if (index < lines.length - 1) offset += 1;
  }
  return starts;
}

function bracesBalanced(text) {
  return braceDelta(text) === 0;
}

function braceDelta(text) {
  const stripped = stripStringsAndComments(text);
  let delta = 0;
  for (const char of stripped) {
    if (char === '{') delta += 1;
    else if (char === '}') delta -= 1;
  }
  return delta;
}

function stripStringsAndComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/gu, '');
}

function languageFor(relativePath) {
  const extension = path.extname(relativePath);
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  return 'javascript';
}

function importAlias(moduleName) {
  const parts = String(moduleName).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? moduleName;
}

function safeTag(value) {
  return String(value).normalize('NFKC').replace(/[^A-Za-z0-9_:-]+/gu, '-').replace(/^-|-$/gu, '') || 'unknown';
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze(item));
  }
  return output;
}

function uniqueObjects(items, key) {
  return uniqueBy(items, (item) => item[key]);
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
