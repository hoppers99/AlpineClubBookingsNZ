"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LodgeOption {
  id: string;
  name: string;
  travelNote?: string | null;
}

// Shared lodge selector honouring the single-lodge presentation rule
// (docs/multi-lodge/decisions/ADR-002): when fewer than two lodges are
// offered it renders nothing and reports the sole lodge (or null) through
// onChange, so surrounding flows behave exactly as a single-lodge club.
export function LodgeSelect({
  lodges,
  value,
  onChange,
  label = "Lodge",
  id = "lodge-select",
}: {
  lodges: LodgeOption[];
  value: string | null;
  onChange: (lodgeId: string | null) => void;
  label?: string;
  id?: string;
}) {
  useEffect(() => {
    if (lodges.length < 2) {
      const sole = lodges[0]?.id ?? null;
      if (value !== sole) onChange(sole);
      return;
    }
    if (value === null && lodges.length > 0) {
      onChange(lodges[0].id);
    }
  }, [lodges, value, onChange]);

  if (lodges.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? undefined}
        onValueChange={(next) => onChange(next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a lodge" />
        </SelectTrigger>
        <SelectContent>
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Fetch active lodges for the current user. `scope: "member"` returns only
 * lodges the member may book; `scope: "admin"` returns every lodge (admin
 * pages pass their own endpoint data instead where they already load it).
 */
export function useLodgeOptions(scope: "member" | "admin" = "member") {
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const url = scope === "admin" ? "/api/admin/lodges" : "/api/lodges";
    fetch(url)
      .then((response) => (response.ok ? response.json() : { lodges: [] }))
      .then((data: { lodges?: Array<LodgeOption & { active?: boolean }> }) => {
        if (cancelled) return;
        const rows = (data.lodges ?? []).filter(
          (lodge) => !("active" in lodge) || lodge.active !== false,
        );
        setLodges(rows.map(({ id, name, travelNote }) => ({ id, name, travelNote })));
      })
      .catch(() => {
        if (!cancelled) setLodges([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return { lodges, loading };
}
