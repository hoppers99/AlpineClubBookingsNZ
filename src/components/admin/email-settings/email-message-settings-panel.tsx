"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenChips } from "@/components/admin/token-help-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Lodge identity (lodge name, travel note, door code) is no longer edited here;
// it comes from each lodge's own settings (Admin → Lodges).
interface EmailSettings {
  clubName: string;
  bookingsName: string;
  emailFromName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
}

interface TemplateOverride {
  subject: string | null;
  bodyText: string | null;
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

interface TemplateDefinition {
  key: string;
  label: string;
  audience: string;
  defaultSubject: string;
  defaultBody: string;
  allowedTokens: string[];
  requiredTokens: string[];
  // Per required token, the other tokens that satisfy the same requirement
  // (#2267). Optional here because the older fixtures/responses omit it.
  requiredTokenAlternatives?: Record<string, string[]>;
  triggerSummary: string;
  frequency: string;
  override: TemplateOverride | null;
}

const settingFields: Array<{
  key: keyof EmailSettings;
  label: string;
  multiline?: boolean;
}> = [
  { key: "clubName", label: "Club name" },
  { key: "bookingsName", label: "Bookings name" },
  { key: "emailFromName", label: "Sender display name" },
  { key: "supportEmail", label: "Support email" },
  { key: "contactEmail", label: "Contact email" },
  { key: "publicUrl", label: "Public URL" },
];

// The template write/preview routes reject an invalid body with a generic
// "Invalid email template" plus a list of specific issues. Showing only the
// generic line left an admin guessing what to change (#2267), so join the
// explanations onto it — every rule the server enforces already carries a
// plain-English message.
function templateErrorMessage(responseBody: unknown, fallback: string): string {
  const body = responseBody as
    | { error?: string; issues?: Array<{ message?: string }> }
    | null
    | undefined;
  const headline = body?.error ?? fallback;
  const details = Array.isArray(body?.issues)
    ? Array.from(
        new Set(
          body.issues
            .map((issue) => issue?.message)
            .filter((message): message is string => Boolean(message)),
        ),
      )
    : [];
  return details.length > 0 ? `${headline}: ${details.join("; ")}` : headline;
}

// A filled chip is the only hint that a token is required, and it says nothing
// about the tokens that satisfy the same requirement instead (#2267). Spell the
// rule out under the chips so an admin learns it while editing, not from a
// rejected save.
export function requiredTokenSentence(
  template: {
    requiredTokens: string[];
    requiredTokenAlternatives?: Record<string, string[]>;
  } | null,
): string | null {
  const required = template?.requiredTokens ?? [];
  if (required.length === 0) return null;
  const parts = required.map((token) => {
    const alternatives = template?.requiredTokenAlternatives?.[token] ?? [];
    if (alternatives.length === 0) return `{{${token}}}`;
    const alternativeText = alternatives
      .map((alternative) => `{{${alternative}}}`)
      .join(" or ");
    return `{{${token}}} (or ${alternativeText})`;
  });
  return `Keep these in the body: ${parts.join(", ")}.`;
}

export function EmailMessageSettingsPanel() {
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [staleOverrideCount, setStaleOverrideCount] = useState(0);
  // #2268 review (MED-1): template names whose SAVED override still carries a
  // pre-sweep "[only when …]" authoring note — literal text every send of that
  // override delivers to its recipient. Save now refuses the junk, but only
  // this banner tells an admin which existing rows still need re-authoring.
  const [bracketAnnotationTemplates, setBracketAnnotationTemplates] = useState<
    string[]
  >([]);
  // #2307 review (M2): saved overrides that still reference a token their
  // template no longer supplies. A missing token renders as NOTHING, so such an
  // override keeps sending with a hole in it — the check-in reminder's old
  // {{guestFirstName}}/{{guestLastName}} pair would have listed no guests at
  // all. Save-time validation refuses them; only this banner tells an admin
  // which stored rows are already affected.
  const [retiredTokenTemplates, setRetiredTokenTemplates] = useState<
    { templateName: string; tokens: string[] }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [forbiddenSave, setForbiddenSave] = useState(false);
  // Email settings and templates are edited under the Support & System area (the
  // write routes enforce support:edit), so gate the editors on that area (#1940).
  const canEdit = useAdminAreaEditAccess("support");

  const currentTemplate = useMemo(
    () => templates.find((template) => template.key === selectedTemplate) ?? null,
    [selectedTemplate, templates],
  );
  const requirementSentence = useMemo(
    () => requiredTokenSentence(currentTemplate),
    [currentTemplate],
  );

  async function load() {
    setLoading(true);
    try {
      const [settingsResponse, templatesResponse] = await Promise.all([
        fetch("/api/admin/email-settings", { credentials: "same-origin" }),
        fetch("/api/admin/email-templates", { credentials: "same-origin" }),
      ]);
      const settingsBody = await settingsResponse.json();
      const templatesBody = await templatesResponse.json();
      if (!settingsResponse.ok) {
        throw new Error(settingsBody?.error ?? "Failed to load email settings");
      }
      if (!templatesResponse.ok) {
        throw new Error(templatesBody?.error ?? "Failed to load email templates");
      }
      const nextTemplates = templatesBody.templates as TemplateDefinition[];
      setSettings(settingsBody.settings);
      setTemplates(nextTemplates);
      setStaleOverrideCount(templatesBody.staleOverrideCount ?? 0);
      setBracketAnnotationTemplates(
        Array.isArray(templatesBody.bracketAnnotationOverrides)
          ? (
              templatesBody.bracketAnnotationOverrides as Array<{
                templateName?: string;
              }>
            )
              .map((entry) => entry?.templateName)
              .filter((name): name is string => Boolean(name))
          : [],
      );
      setRetiredTokenTemplates(
        Array.isArray(templatesBody.retiredTokenOverrides)
          ? (
              templatesBody.retiredTokenOverrides as Array<{
                templateName?: string;
                tokens?: string[];
              }>
            )
              .filter((entry) => Boolean(entry?.templateName))
              .map((entry) => ({
                templateName: entry.templateName as string,
                tokens: Array.isArray(entry.tokens) ? entry.tokens : [],
              }))
          : [],
      );
      const firstTemplate = selectedTemplate || nextTemplates[0]?.key || "";
      setSelectedTemplate(firstTemplate);
      const selected = nextTemplates.find((template) => template.key === firstTemplate);
      if (selected) {
        setSubject(selected.override?.subject ?? selected.defaultSubject);
        setBodyText(selected.override?.bodyText ?? selected.defaultBody);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load email settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectTemplate(key: string) {
    const template = templates.find((entry) => entry.key === key);
    setSelectedTemplate(key);
    setSubject(template?.override?.subject ?? template?.defaultSubject ?? "");
    setBodyText(template?.override?.bodyText ?? template?.defaultBody ?? "");
    setPreviewHtml("");
    setPreviewSubject("");
  }

  async function saveSettings() {
    if (!settings) return;
    setSavingSettings(true);
    setForbiddenSave(false);
    try {
      // Only the editable club-level fields are persisted; the strict API schema
      // rejects the lodge-identity keys the response may still carry.
      const payload = Object.fromEntries(
        settingFields.map((field) => [field.key, settings[field.key]]),
      );
      const response = await fetch("/api/admin/email-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(body?.error ?? "Failed to save email settings");
      }
      setSettings(body.settings);
      toast.success("Email settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email settings");
    } finally {
      setSavingSettings(false);
    }
  }

  async function saveTemplate() {
    if (!currentTemplate) return;
    setSavingTemplate(true);
    setForbiddenSave(false);
    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(
          templateErrorMessage(responseBody, "Failed to save email template"),
        );
      }
      toast.success("Email template saved");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function resetTemplate() {
    if (!currentTemplate) return;
    setSavingTemplate(true);
    setForbiddenSave(false);
    try {
      const response = await fetch("/api/admin/email-templates/reset", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateName: currentTemplate.key }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 403) setForbiddenSave(true);
        throw new Error(responseBody?.error ?? "Failed to reset email template");
      }
      setSubject(currentTemplate.defaultSubject);
      setBodyText(currentTemplate.defaultBody);
      toast.success("Email template reset");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to reset email template");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function previewTemplate() {
    if (!currentTemplate) return;
    try {
      const response = await fetch("/api/admin/email-templates/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateName: currentTemplate.key,
          subject,
          bodyText,
        }),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          templateErrorMessage(responseBody, "Failed to preview email template"),
        );
      }
      setPreviewSubject(responseBody.subject);
      setPreviewHtml(responseBody.html);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to preview email template");
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the panel —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before
    its content appears; a region injected already-populated is silently dropped
    by some screen-reader/browser pairings. That is why it is hoisted above the
    loading early-return and rendered in both branches. It sits OUTSIDE the
    `space-y-8` stack so the empty wrapper an edit-capable admin gets costs no
    layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view email settings and templates but cannot change
      them. Support &amp; System edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading || !settings) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading email settings</p>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-8">
      {forbiddenSave ? <AdminForbiddenSaveNotice /> : null}
      {staleOverrideCount > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {staleOverrideCount} stale template override
          {staleOverrideCount === 1 ? "" : "s"} need database cleanup.
        </div>
      ) : null}
      {bracketAnnotationTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {bracketAnnotationTemplates.length === 1
            ? "A saved template override still contains"
            : `${bracketAnnotationTemplates.length} saved template overrides still contain`}{" "}
          square-bracketed authoring notes (like &ldquo;[only when a door code
          is set]&rdquo;) from the old built-in wording. Emails render tokens
          and nothing else, so these notes are sent to recipients word for
          word. Open each template, remove the bracketed text, and save (or
          reset it to the corrected default):{" "}
          <span className="font-medium">
            {bracketAnnotationTemplates.join(", ")}
          </span>
          .
        </div>
      ) : null}
      {retiredTokenTemplates.length > 0 ? (
        <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          {retiredTokenTemplates.length === 1
            ? "A saved template override still uses"
            : `${retiredTokenTemplates.length} saved template overrides still use`}{" "}
          a token that template no longer offers. A token that is not supplied
          renders as nothing at all, so the line it sits on can go out empty.
          Open each one, swap the old token for the chips now shown, and save
          (or reset it to the current default):{" "}
          <span className="font-medium">
            {retiredTokenTemplates
              .map((entry) => `${entry.templateName} (${entry.tokens.join(", ")})`)
              .join("; ")}
          </span>
          .
        </div>
      ) : null}
      <section className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          {settingFields.map((field) => (
            <div key={field.key} className={field.multiline ? "md:col-span-2" : ""}>
              <Label htmlFor={`email-setting-${field.key}`}>{field.label}</Label>
              {field.multiline ? (
                <Textarea
                  id={`email-setting-${field.key}`}
                  className="mt-1 min-h-24"
                  disabled={!canEdit}
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              ) : (
                <Input
                  id={`email-setting-${field.key}`}
                  className="mt-1"
                  disabled={!canEdit}
                  value={settings[field.key] ?? ""}
                  onChange={(event) =>
                    setSettings((current) =>
                      current
                        ? { ...current, [field.key]: event.target.value }
                        : current,
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Lodge name, travel note, and door code now come from each lodge&apos;s
          own settings (Admin → Lodges).
        </p>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          onClick={saveSettings}
          disabled={savingSettings}
        >
          <Save className="h-4 w-4" />
          {savingSettings ? "Saving" : "Save Email Settings"}
        </ViewOnlyActionButton>
      </section>

      <section className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <div>
            <Label htmlFor="email-template-select">Template</Label>
            <Select value={selectedTemplate} onValueChange={selectTemplate}>
              <SelectTrigger id="email-template-select" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.key} value={template.key}>
                    {template.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {currentTemplate ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{currentTemplate.audience}</Badge>
                <Badge variant="outline">{currentTemplate.key}</Badge>
              </div>
              <p>{currentTemplate.triggerSummary}</p>
              <p>{currentTemplate.frequency}</p>
            </div>
          ) : null}
        </div>

        {currentTemplate ? (
          <div className="space-y-2">
            <Label>Tokens</Label>
            {/* Shared chip renderer; token names stay sourced from the
                email message registry, not the HTML token catalogue. */}
            <TokenChips
              tokens={currentTemplate.allowedTokens.map((token) => ({
                token,
                required: currentTemplate.requiredTokens.includes(token),
              }))}
            />
            {/* #2268: the guidance that used to live inside the default bodies
                as "[only when ...]" notes — which the engine could not act on,
                so it printed them to members. Stated once, here, where an
                operator actually sees it. */}
            <p className="text-muted-foreground text-xs">
              Tokens are substituted as-is — there is no &quot;only if&quot;.
              A value that does not apply to a particular send renders as
              nothing, so writing your own label in front of it (for example
              <code className="mx-1">Door code: {"{{doorCode}}"}</code>) leaves
              a bare label on every email where it is missing. Tokens ending in
              <code className="mx-1">Note</code> or
              <code className="mx-1">Line</code> already contain the whole line,
              label included: put one on a line of its own and it disappears
              cleanly when there is nothing to say. Never write notes to
              yourself into the body — they are sent to the recipient verbatim.
            </p>
            {requirementSentence ? (
              <p className="text-xs text-muted-foreground">
                {requirementSentence}
              </p>
            ) : null}
          </div>
        ) : null}

        <div>
          <Label htmlFor="email-template-subject">Subject</Label>
          <Input
            id="email-template-subject"
            className="mt-1"
            disabled={!canEdit}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="email-template-body">Body</Label>
          <Textarea
            id="email-template-body"
            className="mt-1 min-h-72 font-mono text-sm"
            disabled={!canEdit}
            value={bodyText}
            onChange={(event) => setBodyText(event.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            onClick={saveTemplate}
            disabled={savingTemplate || !currentTemplate}
          >
            <Save className="h-4 w-4" />
            {savingTemplate ? "Saving" : "Save Template"}
          </ViewOnlyActionButton>
          <Button
            variant="outline"
            onClick={previewTemplate}
            disabled={!currentTemplate}
          >
            <Eye className="h-4 w-4" />
            Preview
          </Button>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            variant="outline"
            onClick={resetTemplate}
            disabled={savingTemplate || !currentTemplate}
          >
            <RotateCcw className="h-4 w-4" />
            Restore Default
          </ViewOnlyActionButton>
        </div>

        {previewHtml ? (
          <div className="space-y-3 rounded-md border border-border bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              Subject: {previewSubject}
            </p>
            <iframe
              title="Email preview"
              className="h-[520px] w-full rounded-md border border-border bg-card"
              sandbox=""
              srcDoc={previewHtml}
            />
          </div>
        ) : null}
      </section>
      </div>
    </div>
  );
}
