"use client";

import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { shouldDefaultLinkSideEffects } from "@/lib/admin-member-detail-helpers";
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search";
import type { LinkParentSearchResult, MemberDetail } from "../_types";

interface UseMemberParentLinkParams {
  member: MemberDetail | null;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRelationshipError: Dispatch<SetStateAction<string>>;
}

export function useMemberParentLink({
  member,
  fetchMember,
  setLoading,
  setRelationshipError,
}: UseMemberParentLinkParams) {
  const memberId = member?.id;

  const [parentLinkOpen, setParentLinkOpen] = useState(false);
  const [parentLinkSearch, setParentLinkSearchState] = useState("");
  const [selectedLinkParent, setSelectedLinkParent] =
    useState<LinkParentSearchResult | null>(null);
  const [parentLinkInheritEmail, setParentLinkInheritEmail] = useState(false);
  const [parentLinkNotificationParentId, setParentLinkNotificationParentId] =
    useState("");
  const [parentLinkDisableLogin, setParentLinkDisableLogin] = useState(false);
  const [parentLinkFamilyGroupIds, setParentLinkFamilyGroupIds] = useState<
    string[]
  >([]);
  const [parentLinkSaving, setParentLinkSaving] = useState(false);
  const [parentLinkError, setParentLinkError] = useState("");

  const {
    results: rawParentResults,
    searching: parentLinkSearching,
    error: parentSearchError,
  } = useDebouncedMemberSearch<LinkParentSearchResult>({
    query: parentLinkSearch,
    enabled:
      parentLinkOpen &&
      Boolean(memberId) &&
      (member?.parentLinks?.length ?? 0) < 2,
    params: { pageSize: "8", parentLinkEligibleFor: memberId ?? "" },
    errorFallback: "Failed to search parent members",
  });

  const parentLinkSearchResults = useMemo(
    () =>
      rawParentResults
        .map((candidate) => ({
          id: candidate.id,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
          ageTier: candidate.ageTier,
          active: candidate.active,
          canLogin: candidate.canLogin,
          dateOfBirth: candidate.dateOfBirth,
          familyGroups: candidate.familyGroups ?? [],
        }))
        .filter((candidate) => candidate.id !== selectedLinkParent?.id),
    [rawParentResults, selectedLinkParent?.id],
  );

  // Search and submit errors shared one state before the shared-hook split
  // (#1758): typing a fresh query cleared a stale submit error. Keep that by
  // clearing the submit error on every search edit; the search's own error
  // now arrives via the hook and is merged at the return.
  const setParentLinkSearch = useCallback((value: string) => {
    setParentLinkError("");
    setParentLinkSearchState(value);
  }, []);

  const openParentLinkDialog = () => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setParentLinkSearch("");
    setSelectedLinkParent(null);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId("");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds([]);
    setParentLinkError("");
    setParentLinkOpen(true);
  };

  const selectLinkParent = (candidate: LinkParentSearchResult) => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setSelectedLinkParent(candidate);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId(defaultSideEffects ? candidate.id : "");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds(
      candidate.familyGroups.map((group) => group.id),
    );
    setParentLinkSearch("");
    setParentLinkError("");
  };

  const clearLinkParent = () => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setSelectedLinkParent(null);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId("");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds([]);
    setParentLinkSearch("");
    setParentLinkError("");
  };

  const toggleParentLinkFamilyGroup = (
    familyGroupId: string,
    checked: boolean,
  ) => {
    setParentLinkFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId),
    );
  };

  const handleLinkParent = async () => {
    if (!member || !selectedLinkParent) return;

    setParentLinkSaving(true);
    setParentLinkError("");
    setRelationshipError("");

    try {
      const res = await fetch(
        `/api/admin/members/${selectedLinkParent.id}/dependents/link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memberId: member.id,
            inheritEmail:
              Boolean(parentLinkNotificationParentId) || parentLinkInheritEmail,
            inheritEmailFromId: parentLinkNotificationParentId || null,
            disableLogin: parentLinkDisableLogin,
            addToFamilyGroupIds: parentLinkFamilyGroupIds,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to link parent");
      }

      setParentLinkOpen(false);
      toast.success("Parent linked successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setParentLinkError(
        err instanceof Error ? err.message : "Failed to link parent",
      );
    } finally {
      setParentLinkSaving(false);
    }
  };

  // Suppress unused-variable warnings for state that is still wired into other
  // computations via the closure (inherit flags participate in the inheritEmail
  // request body construction even though they're read inline above).
  void parentLinkInheritEmail;

  return {
    parentLinkOpen,
    parentLinkSearch,
    parentLinkSearchResults,
    parentLinkSearching,
    selectedLinkParent,
    parentLinkNotificationParentId,
    parentLinkDisableLogin,
    parentLinkFamilyGroupIds,
    parentLinkSaving,
    // Submit errors take precedence; a search failure surfaces once the
    // stale submit error is cleared (any search edit clears it).
    parentLinkError: parentLinkError || parentSearchError,
    setParentLinkOpen,
    setParentLinkSearch,
    setSelectedLinkParent,
    setParentLinkInheritEmail,
    setParentLinkNotificationParentId,
    setParentLinkDisableLogin,
    setParentLinkError,
    openParentLinkDialog,
    selectLinkParent,
    clearLinkParent,
    toggleParentLinkFamilyGroup,
    handleLinkParent,
  };
}
