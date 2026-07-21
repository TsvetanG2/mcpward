import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type Config } from './schema.js';
import { ZodError } from 'zod';
import { registerSecret, clearSecrets } from '../report/redact.js';

/**
 * Interpolates ${ENV_VAR} placeholders in a string with environment variables.
 * Registers interpolated values as secrets for redaction.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable "${varName}" is not set`);
    }
    // Register the resolved value as a secret for redaction
    registerSecret(envValue);
    return envValue;
  });
}

/**
 * Recursively interpolates environment variables in an object.
 */
function interpolateObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return interpolateEnv(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateObject);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value);
    }
    return result;
  }
  return obj;
}

/**
 * Formats Zod validation errors into a readable message.
 */
function formatZodError(error: ZodError): string {
  return error.errors
    .map((e) => {
      const path = e.path.join('.');
      return path ? `${path}: ${e.message}` : e.message;
    })
    .join('\n');
}

/**
 * Loads and validates the mcpward configuration file.
 */
export async function loadConfig(configPath: string): Promise<Config> {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\nRun "mcpward init" to create one.`
    );
  }

  const content = await readFile(configPath, 'utf-8');
  const rawConfig = parseYaml(content);

  // Clear any previously registered secrets (for test isolation)
  clearSecrets();

  // Interpolate environment variables (this registers secrets for redaction)
  const interpolated = interpolateObject(rawConfig);

  // Validate with Zod
  const result = ConfigSchema.safeParse(interpolated);

  if (!result.success) {
    throw new Error(`Invalid config:\n${formatZodError(result.error)}`);
  }

  return result.data;
}
