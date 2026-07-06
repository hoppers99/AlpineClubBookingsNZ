"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
import { useXeroStatus } from "@/hooks/use-xero-status"
import type { XeroContactGroup, XeroFeatureFlags } from "../_types"

interface UseXeroContactGroupsOptions {
  onError: (message: string) => void
  onSuccess: (message: string) => void
  refreshMembers: () => Promise<void>
}

export function useXeroContactGroups({
  onError,
  onSuccess,
  refreshMembers,
}: UseXeroContactGroupsOptions) {
  const { connected: xeroConnected, features } = useXeroStatus()
  const xeroFeatures: XeroFeatureFlags = useMemo(
    () => ({
      autoLoadContactGroups: features.autoLoadContactGroups,
      liveMemberGroupLookups: features.liveMemberGroupLookups,
    }),
    [features.autoLoadContactGroups, features.liveMemberGroupLookups]
  )
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([])
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false)

  useEffect(() => {
    if (
      !xeroConnected ||
      !features.autoLoadContactGroups ||
      !features.liveMemberGroupLookups
    ) {
      return
    }
    let cancelled = false
    fetch("/api/admin/xero/contact-groups")
      .then((res) => (res.ok ? res.json() : null))
      .then((groupsData: { groups?: XeroContactGroup[] } | null) => {
        if (!cancelled && groupsData?.groups) {
          setXeroContactGroupsList(groupsData.groups)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    xeroConnected,
    features.autoLoadContactGroups,
    features.liveMemberGroupLookups,
  ])

  const refreshXeroGroups = useCallback(async () => {
    if (!xeroConnected) return

    setRefreshingXeroGroups(true)
    try {
      const result = await loadAdminXeroContactGroups({ refreshFromXero: true })
      setXeroContactGroupsList(result.groups)
      await refreshMembers()
      onSuccess(
        result.groups.length > 0
          ? "Refreshed Xero contact groups"
          : "Refreshed Xero contact groups. No active groups were returned."
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to refresh Xero contact groups")
    } finally {
      setRefreshingXeroGroups(false)
    }
  }, [onError, onSuccess, refreshMembers, xeroConnected])

  return {
    xeroConnected,
    xeroFeatures,
    xeroContactGroupsList,
    refreshingXeroGroups,
    refreshXeroGroups,
  }
}
