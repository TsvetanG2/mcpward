/**
 * Builds the Ajv validator that matches a schema's `$schema` dialect.
 *
 * The default Ajv build only knows draft-07: a schema declaring 2020-12 or 2019-09 fails to
 * compile ("no schema with key or ref"), and keywords such as `prefixItems` are silently not
 * enforced. A schema without `$schema` keeps the draft-07 build, as before.
 */

// Dynamic import for CJS modules - using any for complex module interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClass = any;

let classes: { draft07: AnyClass; draft2019: AnyClass; draft2020: AnyClass } | undefined;
let addFormats: AnyClass;

const DRAFT_2020 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;
const DRAFT_2019 = /^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/;

/** Loads the Ajv builds (CJS modules) once; call before {@link newAjvFor}. */
export async function loadAjv(): Promise<void> {
  if (!classes) {
    const [draft07, draft2019, draft2020, formats] = await Promise.all([
      import('ajv'),
      import('ajv/dist/2019.js'),
      import('ajv/dist/2020.js'),
      import('ajv-formats'),
    ]);
    classes = {
      draft07: draft07.default,
      draft2019: draft2019.default,
      draft2020: draft2020.default,
    };
    addFormats = formats.default;
  }
}

/** A fresh Ajv instance (allErrors, non-strict, with formats) for the schema's dialect. */
export function newAjvFor(schema: unknown): AnyClass {
  if (!classes) throw new Error('loadAjv() must be awaited before newAjvFor()');
  const dialect =
    schema !== null && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as Record<string, unknown>).$schema
      : undefined;
  const AjvClass =
    typeof dialect === 'string' && DRAFT_2020.test(dialect)
      ? classes.draft2020
      : typeof dialect === 'string' && DRAFT_2019.test(dialect)
        ? classes.draft2019
        : classes.draft07;
  const ajv = new AjvClass({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}
