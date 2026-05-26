"use client"

import { useCallback, useEffect, useState } from "react"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
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
  const [xeroConnected, setXeroConnected] = useState<boolean | null>(null)
  const [xeroFeatures, setXeroFeatures] = useState<XeroFeatureFlags>({
    autoLoadContactGroups: false,
    liveMemberGroupLookups: false,
  })
  const [xeroContactGroupsList, setXeroContactGroupsList] = useState<XeroContactGroup[]>([])
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false)

  useEffect(() => {
    fetch("/api/admin/xero/status")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load Xero status")
        return res.json() as Promise<{
          connected?: boolean
          features?: Partial<XeroFeatureFlags>
        }>
      })
      .then((data) => {
        const connected = Boolean(data.connected)
        setXeroConnected(connected)
        setXeroFeatures({
          autoLoadContactGroups: Boolean(data.features?.autoLoadContactGroups),
          liveMemberGroupLookups: Boolean(data.features?.liveMemberGroupLookups),
        })
        if (
          connected &&
          data.features?.autoLoadContactGroups &&
          data.features?.liveMemberGroupLookups
        ) {
          fetch("/api/admin/xero/contact-groups")
            .then((res) => (res.ok ? res.json() : null))
            .then((groupsData: { groups?: XeroContactGroup[] } | null) => {
              if (groupsData?.groups) setXeroContactGroupsList(groupsData.groups)
            })
            .catch(() => {})
        }
      })
      .catch(() => setXeroConnected(false))
  }, [])

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
