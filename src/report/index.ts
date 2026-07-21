export {
  type CheckResult,
  type CheckReport,
  type CheckSummary,
  type CheckStatus,
  type CheckFamily,
  type Severity,
  summarizeResults,
  getExitCode,
} from './model.js';

export { renderConsoleReport, type ConsoleReporterOptions } from './console.js';
export { renderJsonReport, type JsonReporterOptions } from './json.js';
export { renderSarifReport, toHelpAnchor } from './sarif.js';
export { renderJunitReport } from './junit.js';

export {
  redactReport,
  redactString,
  redactValue,
  registerSecret,
  clearSecrets,
  getSecretCount,
} from './redact.js';
