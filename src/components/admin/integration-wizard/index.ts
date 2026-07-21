/**
 * Reusable guided-provider setup wizard shell (#2080).
 *
 * PROVIDER-AGNOSTIC public surface. C4 (Stripe) and C5 (Google) build their
 * setup flows by importing these and supplying their own `context` + `steps`;
 * nothing here names or imports a specific provider.
 */
export { IntegrationWizard } from "./integration-wizard";
export { CopyField } from "./copy-field";
export { useWizardCursor } from "./use-integration-wizard";
export type {
  IntegrationWizardProps,
  WizardStepConfig,
  WizardStepHelpers,
} from "./types";
