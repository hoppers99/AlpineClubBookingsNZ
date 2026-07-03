"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BedDouble,
  CalendarRange,
  ClipboardList,
  KeyRound,
  Lock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Lodge configuration hub (ADR-003): one place to see a lodge's setup state,
// with links into the existing per-area pages pre-filtered via ?lodgeId=.
// Lives inside the multiLodge-gated /admin/lodges route family, so
// single-lodge clubs never see it.

interface LodgeRecord {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  doorCode: string | null;
  travelNote: string | null;
}

interface AreaSummary {
  loaded: boolean;
  count: number;
  detail?: string;
}

const EMPTY_SUMMARY: AreaSummary = { loaded: false, count: 0 };

export default function LodgeConfigurationHubPage() {
  const params = useParams<{ id: string }>();
  const lodgeId = params.id;
  const [lodge, setLodge] = useState<LodgeRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modules, setModules] = useState<Record<string, boolean>>({});
  const [rooms, setRooms] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [lockers, setLockers] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [seasons, setSeasons] = useState<AreaSummary>(EMPTY_SUMMARY);
  const [chores, setChores] = useState<AreaSummary>(EMPTY_SUMMARY);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [lodgesRes, modulesRes] = await Promise.all([
          fetch("/api/admin/lodges"),
          fetch("/api/admin/modules"),
        ]);
        if (!lodgesRes.ok) throw new Error("Failed to load lodge");
        const lodgesData = (await lodgesRes.json()) as {
          lodges: LodgeRecord[];
        };
        const found = lodgesData.lodges.find((row) => row.id === lodgeId);
        if (!found) throw new Error("Lodge not found");
        if (cancelled) return;
        setLodge(found);
        if (modulesRes.ok) {
          const moduleData = (await modulesRes.json()) as Record<
            string,
            unknown
          >;
          if (!cancelled) {
            setModules(
              Object.fromEntries(
                Object.entries(moduleData).filter(
                  ([, value]) => typeof value === "boolean",
                ),
              ) as Record<string, boolean>,
            );
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load lodge",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  useEffect(() => {
    let cancelled = false;
    const query = `lodgeId=${encodeURIComponent(lodgeId)}`;

    fetch(`/api/admin/bed-allocation/rooms?${query}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const bedCount = (data.rooms ?? []).reduce(
          (total: number, room: { beds: unknown[] }) =>
            total + room.beds.length,
          0,
        );
        setRooms({
          loaded: true,
          count: data.rooms?.length ?? 0,
          detail: `${bedCount} bed${bedCount === 1 ? "" : "s"} · capacity ${data.capacity?.capacity ?? 0}`,
        });
      })
      .catch(() => {});

    fetch(`/api/admin/lockers?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setLockers({ loaded: true, count: data.lockers?.length ?? 0 });
      })
      .catch(() => {});

    fetch(`/api/admin/seasons?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const active = data.filter(
          (season: { active: boolean }) => season.active,
        ).length;
        setSeasons({
          loaded: true,
          count: data.length,
          detail: `${active} active`,
        });
      })
      .catch(() => {});

    fetch(`/api/admin/chores?${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        setChores({ loaded: true, count: data.length });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [lodgeId]);

  const areas = [
    {
      key: "rooms",
      enabled: modules.bedAllocation !== false,
      title: "Rooms & Beds",
      icon: BedDouble,
      href: `/admin/rooms-beds?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: rooms,
      emptyHint: "No rooms yet — capacity resolves to 0 until beds exist.",
      unit: "room",
    },
    {
      key: "lockers",
      enabled: modules.lockers !== false,
      title: "Lockers",
      icon: Lock,
      href: `/admin/lockers?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: lockers,
      emptyHint: "No lockers yet.",
      unit: "locker",
    },
    {
      key: "seasons",
      enabled: true,
      title: "Seasons & Rates",
      icon: CalendarRange,
      href: `/admin/seasons?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: seasons,
      emptyHint: "No seasons yet — nights here cannot be priced until one exists.",
      unit: "season",
    },
    {
      key: "chores",
      enabled: modules.chores !== false,
      title: "Chores",
      icon: ClipboardList,
      href: `/admin/chores?lodgeId=${encodeURIComponent(lodgeId)}`,
      summary: chores,
      emptyHint: "No chore templates yet — rosters here will be empty.",
      unit: "chore template",
    },
  ].filter((area) => area.enabled);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading lodge...</p>
    );
  }

  if (error || !lodge) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive" role="alert">
          {error ?? "Lodge not found."}
        </p>
        <Button asChild variant="outline">
          <Link href="/admin/lodges">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to lodges
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{lodge.name}</h1>
            <Badge variant={lodge.active ? "default" : "secondary"}>
              {lodge.active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Everything this lodge needs, in one place. Each area opens the
            usual page filtered to this lodge.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/lodges/${encodeURIComponent(lodgeId)}/setup`}>
              Setup wizard
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/lodges">
              <ArrowLeft className="mr-2 h-4 w-4" />
              All lodges
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Identity
          </CardTitle>
          <CardDescription>
            The name, door code, and travel note appear in this lodge&apos;s
            booking and pre-arrival emails. Edit them on the{" "}
            <Link href="/admin/lodges" className="underline">
              Lodges page
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-muted-foreground">Door code</p>
            <p className="font-medium">
              {lodge.doorCode ?? "Not set — door-code emails omit it"}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-muted-foreground">Travel note</p>
            <p className="font-medium">
              {lodge.travelNote ?? "Not set — emails fall back to the club-wide note"}
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {areas.map((area) => {
          const Icon = area.icon;
          const configured = area.summary.loaded && area.summary.count > 0;
          return (
            <Card key={area.key}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" />
                    {area.title}
                  </span>
                  {area.summary.loaded ? (
                    <Badge variant={configured ? "default" : "secondary"}>
                      {configured
                        ? `${area.summary.count} ${area.unit}${area.summary.count === 1 ? "" : "s"}`
                        : "Not set up"}
                    </Badge>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {configured
                    ? area.summary.detail ?? "Configured."
                    : area.emptyHint}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link href={area.href}>Configure</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
