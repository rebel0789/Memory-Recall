function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function typesMatch(expected, value) {
  const actual = valueType(value);
  const allowed = Array.isArray(expected) ? expected : [expected];
  return allowed.some((type) => type === actual || (type === 'number' && actual === 'integer'));
}

function resolveLocalRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  return reference.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((value, key) => value?.[key], rootSchema);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'type',
  'additionalProperties',
  'required',
  'properties',
  'items',
  'oneOf',
  'const',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default'
]);

function assertSupportedSchema(schema, path = '$') {
  if (schema === true || schema === false) return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      const error = new Error(`Unsupported JSON Schema keyword at ${path}: ${key}`);
      error.code = 'unsupported_schema_keyword';
      error.keyword = key;
      throw error;
    }
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) assertSupportedSchema(value, `${path}.properties.${key}`);
  if (schema.items) assertSupportedSchema(schema.items, `${path}.items`);
  if (schema.oneOf) {
    if (!Array.isArray(schema.oneOf)) {
      const error = new Error(`Unsupported JSON Schema keyword at ${path}: oneOf`);
      error.code = 'unsupported_schema_keyword';
      error.keyword = 'oneOf';
      throw error;
    }
    schema.oneOf.forEach((item, index) => assertSupportedSchema(item, `${path}.oneOf[${index}]`));
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  for (const [key, value] of Object.entries(schema.$defs ?? {})) assertSupportedSchema(value, `${path}.$defs.${key}`);
}

function validateNode(schema, value, path, rootSchema, errors) {
  if (schema === true) return;
  if (schema === false) { errors.push({ path, keyword: 'falseSchema', message: 'value is forbidden' }); return; }
  if (!schema || typeof schema !== 'object') { errors.push({ path, keyword: 'schema', message: 'schema node is invalid' }); return; }
  if (schema.$ref) {
    const resolved = resolveLocalRef(rootSchema, schema.$ref);
    if (!resolved) errors.push({ path, keyword: '$ref', message: `unable to resolve ${schema.$ref}` });
    else validateNode(resolved, value, path, rootSchema, errors);
    return;
  }
  if (schema.oneOf) {
    const branchErrorsByIndex = [];
    const matches = schema.oneOf.filter((item, index) => {
      const branchErrors = [];
      validateNode(item, value, path, rootSchema, branchErrors);
      if (branchErrors.length > 0) branchErrorsByIndex.push({ index, errors: branchErrors });
      return branchErrors.length === 0;
    }).length;
    if (matches !== 1) {
      const detail = branchErrorsByIndex
        .slice(0, 2)
        .map(({ index, errors: branchErrors }) => {
          const sample = branchErrors
            .slice(0, 3)
            .map((item) => `${item.path} ${item.message}`)
            .join('; ');
          return `branch ${index}: ${sample}`;
        })
        .join(' | ');
      errors.push({
        path,
        keyword: 'oneOf',
        message: `${matches === 0 ? 'must match exactly one schema' : 'must match only one schema'}${detail ? ` (${detail})` : ''}`
      });
      return;
    }
  }
  if (schema.type !== undefined && !typesMatch(schema.type, value)) {
    errors.push({ path, keyword: 'type', message: `expected ${JSON.stringify(schema.type)}, received ${valueType(value)}` });
    return;
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) errors.push({ path, keyword: 'const', message: `must equal ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(candidate, value))) errors.push({ path, keyword: 'enum', message: 'value is not in enum' });

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, keyword: 'minLength', message: `must contain at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, keyword: 'maxLength', message: `must contain no more than ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, keyword: 'pattern', message: `must match ${schema.pattern}` });
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push({ path, keyword: 'format', message: 'must be a valid date-time' });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: 'minimum', message: `must be at least ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: 'maximum', message: `must be at most ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: 'minItems', message: `must contain at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: 'maxItems', message: `must contain no more than ${schema.maxItems} items` });
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push({ path, keyword: 'uniqueItems', message: 'items must be unique' });
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, rootSchema, errors));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) errors.push({ path, keyword: 'minProperties', message: `must contain at least ${schema.minProperties} properties` });
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) errors.push({ path, keyword: 'maxProperties', message: `must contain no more than ${schema.maxProperties} properties` });
    for (const required of schema.required ?? []) if (!(required in value)) errors.push({ path: `${path}.${required}`, keyword: 'required', message: 'property is required' });
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateNode(properties[key], item, `${path}.${key}`, rootSchema, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: 'additional property is not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateNode(schema.additionalProperties, item, `${path}.${key}`, rootSchema, errors);
    }
  }
}

export function validateJsonSchema(schema, value) {
  assertSupportedSchema(schema);
  const errors = [];
  validateNode(schema, value, '$', schema, errors);
  return { valid: errors.length === 0, errors };
}

export function assertJsonSchema(schema, value, label = 'value') {
  const result = validateJsonSchema(schema, value);
  if (!result.valid) {
    const error = new Error(`${label} failed schema validation: ${result.errors.map((item) => `${item.path} ${item.message}`).join('; ')}`);
    error.code = 'schema_validation_failed';
    error.errors = result.errors;
    throw error;
  }
  return value;
}
