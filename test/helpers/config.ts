import { ConfigSchema, type Config, type ConfigInput } from '../../src/config/schema.js';

/**
 * Builds a Config the way the CLI does: from user-shaped input, through ConfigSchema, so
 * defaults are applied and tests exercise the same parsed shape production code receives.
 */
export function testConfig(input: ConfigInput): Config {
  return ConfigSchema.parse(input);
}

/** The resolved latency config of a test config (throws if the test forgot to set one). */
export function latencyOf(config: Config): NonNullable<NonNullable<Config['checks']>['latency']> {
  const latency = config.checks?.latency;
  if (!latency) throw new Error('test config has no checks.latency');
  return latency;
}
