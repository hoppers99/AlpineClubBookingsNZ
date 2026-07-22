import {
  detectLegacyProviderEnv,
  getOperationalXeroRedirectUri,
} from "@/lib/xero-config";
import { XeroSetupPageClient } from "../_components/xero-setup-page-client";

// Server component: resolves the server-derived setup config (the C1 redirect
// URI, legacy env detection) once, then renders the interactive client body.
// The guided wizard (#2080) is the credential-entry + connect surface; it
// supersedes the interim credentials section from C1.
export default function XeroSetupPage() {
  const redirectUri = getOperationalXeroRedirectUri();
  const companyUrl = redirectUri ? new URL(redirectUri).origin : "";
  const legacyEnvVars =
    detectLegacyProviderEnv().find((f) => f.provider === "xero")?.vars ?? [];

  return (
    <XeroSetupPageClient
      serverConfig={{ redirectUri, companyUrl, legacyEnvVars }}
    />
  );
}
