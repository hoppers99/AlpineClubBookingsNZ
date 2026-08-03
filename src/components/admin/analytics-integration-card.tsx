"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BarChart3, ExternalLink } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CHIP_TONE_CLASSES, type ChipTone } from "@/lib/chip-tones";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  ANALYTICS_BANNER_MESSAGE_MAX_LENGTH,
  ANALYTICS_STATUS_LABELS,
  type AnalyticsIntegrationStatus,
  type AnalyticsSettingsValues,
} from "@/lib/analytics-settings";
import {
  PRIVACY_POLICY_ADMIN_HREF,
  type PrivacyPolicyPageState,
} from "@/lib/analytics-privacy-policy";

/**
 * Google Analytics as a peer integration on Admin -> Integrations (#2573, owner
 * decision section 1).
 *
 * ## Why a card that opens a dialog, and not a route
 *
 * The owner's decision is explicit on both halves: Google Analytics appears "as a
 * peer integration under Admin -> Integrations, alongside integrations such as Xero
 * and Stripe", and "do not add a dedicated `/admin/analytics/setup` route". The
 * decision supersedes the route the issue body originally proposed (clarification 4)
 * and permits "an inline panel, dialog, drawer or equivalent established pattern"
 * that "remains part of the Integrations experience rather than becoming a separate
 * standalone admin section".
 *
 * Every other card on that hub is a link to its own page, so this card keeps the same
 * shell — same `Card`, same icon-and-title header, same description — and differs in
 * being a BUTTON that opens the settings dialog in place. It also carries the status
 * line the decision asks for, which the link cards have no equivalent of, because
 * "Setup required" versus "Configured without consent banner" is the thing an admin
 * most needs to see at a glance on a privacy setting.
 *
 * ## The settings pattern, and where it deliberately differs
 *
 * `AGENTS.md`'s canonical settings pattern applies: the section loads read-only, a
 * per-section Edit reveals Save/Cancel, no control auto-persists, Cancel restores
 * every field from the snapshot and Save persists once — implemented with the shared
 * `useSectionEditState` hook rather than hand-rolled, and re-seeded from the parsed
 * SERVER response (this route normalises: it trims, collapses whitespace, and keeps
 * the stored wording when an empty message is submitted in banner-off mode, so
 * re-seeding from the draft would leave the form disagreeing with storage).
 *
 * "Ask visitors to choose again" is NOT a staged field. It is a discrete ACTION with
 * its own confirmation, in the same class as the row-level Activate/Deactivate actions
 * the pattern already sanctions — and it must not be reachable through Save, because
 * an ordinary Save silently re-prompting every visitor is precisely what owner
 * decision section 6 forbids.
 *
 * The dialog renders its own `AdminViewOnlySectionBanner`. That is the sanctioned
 * shape for dialog contents, which an ancestor's banner cannot reach, and it is why
 * every gated control here passes `describeReason={false}`.
 */

interface AnalyticsSettingsPayload {
  settings: AnalyticsSettingsValues;
  status: AnalyticsIntegrationStatus;
  defaultBannerMessage: string;
  privacyPolicy: PrivacyPolicyPageState;
}

interface AnalyticsDraft {
  measurementId: string;
  consentBannerEnabled: boolean;
  bannerMessage: string;
}

const SETTINGS_ENDPOINT = "/api/admin/integrations/analytics";
const RECONSENT_ENDPOINT = "/api/admin/integrations/analytics/reconsent";

/**
 * Owner decision section 10, reproduced as the prominent warning the setup must
 * carry. Held as a constant so the wording is in one place and a test can pin it: the
 * application must never describe either consent mode as legally compliant, approved
 * or exempt, and the final sentence is the disclaimer that says so outright.
 */
const PRIVACY_AND_LEGAL_WARNING = [
  "Whether or not you display the consent banner, your organisation should disclose " +
    "its use of Google Analytics in the website privacy policy. Privacy, cookie and " +
    "consent requirements can change and may depend on where your visitors are " +
    "located and how Google Analytics is configured. Check the current New Zealand " +
    "privacy requirements, and any other laws that apply to your visitors, before " +
    "relying on this setting.",
  "This application does not determine whether your selected configuration is " +
    "legally compliant.",
] as const;

/**
 * Owner decision section 4: the administrator must receive a clear warning BEFORE
 * saving banner-off mode, explaining that Google Analytics will load automatically
 * without asking visitors first and that the organisation remains responsible for its
 * privacy disclosures and legal assessment.
 *
 * Shown as soon as the option is selected in the draft — i.e. before Save, not after
 * it — which is what "before saving this mode" requires.
 */
const BANNER_OFF_WARNING =
  "Google Analytics will load automatically on eligible public pages without asking " +
  "visitors first. Visitors who previously declined through the banner will start " +
  "being measured again, and can only opt out afterwards using the Analytics " +
  "preferences link in the website footer. Your organisation remains responsible for " +
  "its privacy disclosures and for its own assessment of the laws that apply.";

function statusTone(status: AnalyticsIntegrationStatus): ChipTone {
  switch (status) {
    case "configured_with_banner":
      return "success";
    case "configured_without_banner":
      return "warning";
    case "invalid_configuration":
      return "danger";
    default:
      return "neutral";
  }
}

export function AnalyticsIntegrationCard() {
  const canEdit = useAdminAreaEditAccess("finance");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AnalyticsIntegrationStatus | null>(null);
  const [defaultBannerMessage, setDefaultBannerMessage] = useState("");
  const [privacyPolicy, setPrivacyPolicy] =
    useState<PrivacyPolicyPageState | null>(null);
  const [confirmingReconsent, setConfirmingReconsent] = useState(false);
  const [reconsentBusy, setReconsentBusy] = useState(false);
  const [reconsentMessage, setReconsentMessage] = useState("");
  const [reconsentError, setReconsentError] = useState("");
  // In-flight guard held in a ref, not just a disabled button: two clicks dispatched
  // inside one tick both see the pre-update state, so both would POST and the second
  // would write a second revision bump nobody asked for.
  const reconsentInFlight = useRef(false);

  const applyPayload = useCallback((payload: AnalyticsSettingsPayload) => {
    setStatus(payload.status);
    setDefaultBannerMessage(payload.defaultBannerMessage);
    setPrivacyPolicy(payload.privacyPolicy);
  }, []);

  const section = useSectionEditState<AnalyticsDraft>({
    load: async (signal) => {
      const response = await fetch(SETTINGS_ENDPOINT, {
        signal,
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error("Could not load the Google Analytics settings.");
      }
      const payload = (await response.json()) as AnalyticsSettingsPayload;
      applyPayload(payload);
      return {
        measurementId: payload.settings.measurementId ?? "",
        consentBannerEnabled: payload.settings.consentBannerEnabled,
        bannerMessage: payload.settings.bannerMessage,
      };
    },
    save: async (draft) => {
      const response = await fetch(SETTINGS_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Could not save the Google Analytics settings.";
        throw new Error(message);
      }
      const saved = payload as AnalyticsSettingsPayload;
      applyPayload(saved);
      // Re-seed from the SERVER's values, never the draft: the route trims the
      // measurement ID, collapses whitespace in the message, and substitutes the
      // stored wording when an empty message arrives with the banner off.
      return {
        measurementId: saved.settings.measurementId ?? "",
        consentBannerEnabled: saved.settings.consentBannerEnabled,
        bannerMessage: saved.settings.bannerMessage,
      };
    },
    successMessage: "Google Analytics settings saved.",
  });

  const draft = section.draft;

  // `useSectionEditState` loads on MOUNT, and the card is always mounted: the status
  // line on the card is the whole point, so the settings have to be read before the
  // dialog is opened. Closing the dialog only clears the action feedback, so a
  // reopened dialog does not still show the last message.
  useEffect(() => {
    if (!open) {
      setReconsentMessage("");
      setReconsentError("");
      setConfirmingReconsent(false);
    }
  }, [open]);

  const runReconsent = useCallback(async () => {
    if (reconsentInFlight.current) return;
    reconsentInFlight.current = true;
    setReconsentBusy(true);
    setReconsentError("");
    setReconsentMessage("");
    try {
      const response = await fetch(RECONSENT_ENDPOINT, { method: "POST" });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Could not ask visitors to choose again.";
        setReconsentError(message);
        return;
      }
      const saved = payload as {
        settings: AnalyticsSettingsValues;
        status: AnalyticsIntegrationStatus;
      };
      setStatus(saved.status);
      setReconsentMessage(
        `Visitors will be asked to choose again. Consent revision is now ${saved.settings.consentRevision}.`,
      );
      setConfirmingReconsent(false);
    } catch {
      setReconsentError("Could not ask visitors to choose again.");
    } finally {
      reconsentInFlight.current = false;
      setReconsentBusy(false);
    }
  }, []);

  const privacyPolicyMissing = privacyPolicy
    ? !privacyPolicy.exists || !privacyPolicy.published
    : false;

  return (
    <>
      <Card className="h-full text-left transition-colors hover:border-brand-gold/70">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 shrink-0 text-foreground" />
            <CardTitle>Google Analytics</CardTitle>
          </div>
          <CardDescription>
            Configure your GA4 measurement ID, the visitor consent banner and the
            analytics privacy settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {status ? (
            <span
              data-testid="analytics-integration-status"
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_TONE_CLASSES[statusTone(status)]}`}
            >
              {ANALYTICS_STATUS_LABELS[status]}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
          >
            {status && status !== "setup_required"
              ? "Manage Google Analytics"
              : "Set up Google Analytics"}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Google Analytics</DialogTitle>
            <DialogDescription>
              Google Analytics runs on the public website only. It never runs on
              admin pages, signed-in member pages, or any page whose address carries
              a token, PIN or personal identifier, and the addresses it reports are
              sent without query strings or fragments.
            </DialogDescription>
          </DialogHeader>

          <AdminViewOnlySectionBanner canEdit={canEdit}>
            Google Analytics settings need finance edit access.
          </AdminViewOnlySectionBanner>

          <Alert variant="warning" title="Privacy and legal responsibility">
            <div className="space-y-2">
              {PRIVACY_AND_LEGAL_WARNING.map((paragraph) => (
                <p key={paragraph.slice(0, 24)}>{paragraph}</p>
              ))}
            </div>
          </Alert>

          {privacyPolicyMissing ? (
            <Alert variant="error" title="No published privacy policy">
              <p>
                This website has no published privacy policy page, so visitors have
                nowhere to read how the club uses Google Analytics. Publish one under{" "}
                <Link
                  href={privacyPolicy?.adminHref ?? PRIVACY_POLICY_ADMIN_HREF}
                  className="underline"
                >
                  Website pages
                </Link>
                . You can still finish this setup first.
              </p>
            </Alert>
          ) : privacyPolicy ? (
            <p className="text-sm text-muted-foreground">
              Your published privacy policy is at{" "}
              <Link href={privacyPolicy.publicPath} className="underline">
                {privacyPolicy.publicPath}
              </Link>
              . Make sure it explains the club&apos;s use of Google Analytics.
            </p>
          ) : null}

          {section.loading || !draft ? (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="analytics-measurement-id">
                  GA4 measurement ID
                </Label>
                <Input
                  id="analytics-measurement-id"
                  value={draft.measurementId}
                  disabled={!section.editing}
                  placeholder="G-XXXXXXXXXX"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    section.setDraft({ measurementId: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Find it in Google Analytics under Admin, Data streams, then your
                  web stream. It is configuration rather than a secret — it appears
                  in the page source of every page analytics runs on. Clear the field
                  to switch analytics off. No restart or redeploy is needed.
                </p>
              </div>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-foreground">
                  Visitor consent banner
                </legend>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="analytics-consent-mode"
                    className="mt-1"
                    checked={draft.consentBannerEnabled}
                    disabled={!section.editing}
                    onChange={() =>
                      section.setDraft({ consentBannerEnabled: true })
                    }
                  />
                  <span>
                    <span className="font-medium">
                      Show the consent banner (recommended)
                    </span>
                    <span className="block text-muted-foreground">
                      Google Analytics does not load, and nothing is sent to Google,
                      until a visitor selects Accept. Declining or dismissing the
                      banner leaves analytics switched off.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="radio"
                    name="analytics-consent-mode"
                    className="mt-1"
                    checked={!draft.consentBannerEnabled}
                    disabled={!section.editing}
                    onChange={() =>
                      section.setDraft({ consentBannerEnabled: false })
                    }
                  />
                  <span>
                    <span className="font-medium">
                      Do not show the consent banner
                    </span>
                    <span className="block text-muted-foreground">
                      Google Analytics loads automatically on eligible public pages
                      without asking the visitor first.
                    </span>
                  </span>
                </label>

                {!draft.consentBannerEnabled ? (
                  <Alert
                    variant="warning"
                    title="Analytics will load without asking visitors"
                  >
                    <p>{BANNER_OFF_WARNING}</p>
                  </Alert>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  Advertising storage, advertising user data and advertising
                  personalisation stay switched off in both modes. The public
                  Analytics preferences link in the website footer works in both
                  modes too, so a visitor can always change their mind.
                </p>
              </fieldset>

              <div className="space-y-2">
                <Label htmlFor="analytics-banner-message">Banner message</Label>
                <Textarea
                  id="analytics-banner-message"
                  value={draft.bannerMessage}
                  disabled={!section.editing}
                  rows={3}
                  maxLength={ANALYTICS_BANNER_MESSAGE_MAX_LENGTH}
                  onChange={(event) =>
                    section.setDraft({ bannerMessage: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Plain text only, up to {ANALYTICS_BANNER_MESSAGE_MAX_LENGTH}{" "}
                  characters. HTML and Markdown are shown literally rather than
                  interpreted. The Accept and Decline button labels are set by the
                  application. The wording is kept while the banner is switched off.
                </p>
                {section.editing && defaultBannerMessage ? (
                  <ViewOnlyActionButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={() =>
                      section.setDraft({ bannerMessage: defaultBannerMessage })
                    }
                  >
                    Restore the suggested wording
                  </ViewOnlyActionButton>
                ) : null}
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs font-medium text-foreground">
                    Banner preview
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {draft.bannerMessage || defaultBannerMessage}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Accept · Decline · Close (Close means decline)
                  </p>
                </div>
              </div>

              {section.error ? (
                <div role="alert" className="text-sm text-destructive">
                  {section.error}
                </div>
              ) : null}
              <div role="status" className="text-sm text-muted-foreground">
                {section.success}
              </div>

              <div className="flex flex-wrap gap-2">
                {section.editing ? (
                  <>
                    <ViewOnlyActionButton
                      type="button"
                      canEdit={canEdit}
                      describeReason={false}
                      disabled={section.saving || !section.dirty}
                      onClick={() => {
                        void section.save();
                      }}
                    >
                      {section.saving ? "Saving…" : "Save"}
                    </ViewOnlyActionButton>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={section.saving}
                      onClick={() => section.cancelEditing()}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <ViewOnlyActionButton
                    type="button"
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={() => section.startEditing()}
                  >
                    Edit
                  </ViewOnlyActionButton>
                )}
              </div>

              {/*
                Re-consent: a discrete ACTION, never part of Save. Hidden entirely
                while the banner is off (owner clarification 2) — there is no prompt
                to show in that mode, and bumping the revision there could only
                discard a preference a visitor set deliberately. Gated on the SAVED
                mode rather than the draft, so an unsaved switch does not offer an
                action the server would refuse.
              */}
              {section.saved?.consentBannerEnabled ? (
                <div className="space-y-2 rounded-md border border-border px-3 py-3">
                  <p className="text-sm font-medium text-foreground">
                    Ask visitors to choose again
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Clears every visitor&apos;s stored banner choice so the consent
                    banner is shown again on their next visit. Editing the wording on
                    its own does not do this.
                  </p>
                  {confirmingReconsent ? (
                    <div className="space-y-2">
                      <p className="text-sm text-foreground">
                        Every visitor will see the consent banner again on their next
                        eligible page, and analytics will not run for them until they
                        choose. This cannot be undone.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <ViewOnlyActionButton
                          type="button"
                          variant="destructive"
                          canEdit={canEdit}
                          describeReason={false}
                          disabled={reconsentBusy}
                          onClick={() => {
                            void runReconsent();
                          }}
                        >
                          {reconsentBusy
                            ? "Asking…"
                            : "Yes, ask visitors to choose again"}
                        </ViewOnlyActionButton>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={reconsentBusy}
                          onClick={() => setConfirmingReconsent(false)}
                        >
                          Keep current choices
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <ViewOnlyActionButton
                      type="button"
                      variant="outline"
                      size="sm"
                      canEdit={canEdit}
                      describeReason={false}
                      onClick={() => setConfirmingReconsent(true)}
                    >
                      Ask visitors to choose again
                    </ViewOnlyActionButton>
                  )}
                  {reconsentError ? (
                    <div role="alert" className="text-sm text-destructive">
                      {reconsentError}
                    </div>
                  ) : null}
                  <div role="status" className="text-sm text-muted-foreground">
                    {reconsentMessage}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <a
              href="https://support.google.com/analytics/answer/9539598"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-sm underline"
            >
              Find your measurement ID
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
