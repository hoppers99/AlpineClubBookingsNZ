"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import {
  emptyBuilderModel,
  parseBuilderModel,
  type BuilderModel,
} from "@/lib/lodge-display/builder-model";
import { isBuiltInDisplayTemplateKey } from "@/lib/lodge-display/built-in-seeds";
import DisplayBuilder from "./display-builder";

// Visual builder surface (ADR-004 §1/§4). A NEW board is composed from a blank
// skeleton; an EXISTING template opens here only when its Layout carries the
// dlb-root signature AND round-trips (parseBuilderModel). A hand-authored or
// advanced-broken layout degrades to Advanced-only with a clear banner + a
// "Rebuild in builder (replaces the body)" escape hatch — never silently
// reinterpreted (ADR-004 §4).

interface LoadedTemplate {
  id: string;
  key: string;
  name: string;
  layout: {
    id: string;
    bodyHtml: string;
    defaultCss: string;
    areas: unknown;
  };
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

type Loaded =
  | { status: "loading" }
  | { status: "new" }
  | {
      status: "open";
      layoutId: string | null;
      templateId: string | null;
      model: BuilderModel;
      key: string;
      name: string;
      footerHtml: string;
      cssOverrides: string;
      defaultCssCustomised: boolean;
      isBuiltIn: boolean;
    }
  | {
      status: "advanced-only";
      templateId: string;
      loaded: LoadedTemplate;
    }
  | { status: "error"; message: string };

function readTemplateId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("templateId");
}

export default function DisplayBuilderPage() {
  const canEdit = useAdminAreaEditAccess("lodge");
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [lodges, setLodges] = useState<{ id: string; name: string }[]>([]);
  // A "Rebuild in builder" click forces a fresh skeleton while keeping the ids so
  // Save overwrites the same rows (ADR-004 §4).
  const [rebuild, setRebuild] = useState(false);

  const load = useCallback(async () => {
    const lodgesRes = await fetch("/api/admin/lodges").catch(() => null);
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json()) as {
        lodges?: Array<{ id: string; name: string; active?: boolean }>;
      };
      setLodges(
        (body.lodges ?? [])
          .filter((l) => l.active !== false)
          .map((l) => ({ id: l.id, name: l.name }))
      );
    }

    const templateId = readTemplateId();
    if (!templateId) {
      setState({ status: "new" });
      return;
    }
    const res = await fetch(`/api/admin/display/templates/${templateId}`);
    if (!res.ok) {
      setState({ status: "error", message: "Could not load that board." });
      return;
    }
    const body = (await res.json()) as { template: LoadedTemplate };
    const t = body.template;
    const parsed = parseBuilderModel({
      bodyHtml: t.layout.bodyHtml,
      defaultCss: t.layout.defaultCss,
      areas: t.layout.areas,
      slotContent: t.slotContent,
    });
    if (parsed.ok) {
      setState({
        status: "open",
        layoutId: t.layout.id,
        templateId: t.id,
        model: parsed.model,
        key: t.key,
        name: t.name,
        footerHtml: t.footerHtml,
        cssOverrides: t.cssOverrides,
        defaultCssCustomised: parsed.defaultCssCustomised,
        isBuiltIn: isBuiltInDisplayTemplateKey(t.key),
      });
    } else {
      setState({ status: "advanced-only", templateId: t.id, loaded: t });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Visual builder</h1>
        <p className="text-muted-foreground text-sm">
          Compose a board by picking a shape and dropping modules into zones. No
          HTML required — the builder writes a valid layout and template for you.
          For full control, use{" "}
          <Link className="underline" href="/admin/display/layouts">
            Advanced mode
          </Link>
          .
        </p>
      </div>

      {!canEdit && (
        <AdminViewOnlyNotice>
          Your admin role can view the visual builder but cannot save. Lodge edit
          access is required to author a board.
        </AdminViewOnlyNotice>
      )}

      {state.status === "loading" && <p className="text-muted-foreground text-sm">Loading…</p>}

      {state.status === "error" && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border p-3 text-sm">
          {state.message}
        </div>
      )}

      {state.status === "advanced-only" && !rebuild && (
        <div className="space-y-3 rounded-md border border-amber-400/50 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">This board can&apos;t be opened in the visual builder.</p>
          <p>
            It was hand-edited (or built with a different layout idiom), so the
            builder can&apos;t safely reinterpret it. Edit it in{" "}
            <Link className="underline" href="/admin/display/templates">
              Advanced mode
            </Link>
            , or rebuild it in the builder — which <strong>replaces the layout
            body</strong> with a fresh skeleton (your current body is discarded).
          </p>
          <Button variant="outline" disabled={!canEdit} onClick={() => setRebuild(true)}>
            Rebuild in builder (replaces the body)
          </Button>
        </div>
      )}

      {state.status === "new" && (
        <DisplayBuilder
          layoutId={null}
          templateId={null}
          initialModel={emptyBuilderModel("side-rail", 2)}
          initialKey=""
          initialName=""
          initialFooterHtml=""
          initialCssOverrides=""
          isBuiltIn={false}
          canEdit={canEdit}
          lodges={lodges}
          onDuplicate={() => undefined}
        />
      )}

      {state.status === "open" && (
        <DisplayBuilder
          layoutId={state.layoutId}
          templateId={state.templateId}
          initialModel={state.model}
          initialKey={state.key}
          initialName={state.name}
          initialFooterHtml={state.footerHtml}
          initialCssOverrides={state.cssOverrides}
          isBuiltIn={state.isBuiltIn}
          canEdit={canEdit}
          lodges={lodges}
          defaultCssCustomised={state.defaultCssCustomised}
          onDuplicate={() => {
            // Fork to a new pair: clear the ids + suffix the key/name (mirrors the
            // existing duplicate-to-customise fork), so Save creates fresh rows.
            setState({
              status: "open",
              layoutId: null,
              templateId: null,
              model: state.model,
              key: `${state.key}-copy`,
              name: `${state.name} (copy)`,
              defaultCssCustomised: false,
              cssOverrides: state.cssOverrides,
              footerHtml: state.footerHtml,
              isBuiltIn: false,
            });
          }}
        />
      )}

      {state.status === "advanced-only" && rebuild && (
        <DisplayBuilder
          layoutId={state.loaded.layout.id}
          templateId={state.loaded.id}
          initialModel={emptyBuilderModel("side-rail", 2)}
          initialKey={state.loaded.key}
          initialName={state.loaded.name}
          initialFooterHtml={state.loaded.footerHtml}
          initialCssOverrides={state.loaded.cssOverrides}
          isBuiltIn={isBuiltInDisplayTemplateKey(state.loaded.key)}
          canEdit={canEdit}
          lodges={lodges}
          onDuplicate={() => undefined}
        />
      )}
    </div>
  );
}
