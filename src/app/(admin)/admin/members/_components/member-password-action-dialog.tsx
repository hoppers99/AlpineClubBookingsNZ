"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"
import {
  ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS,
  DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW,
  getAdminPasswordResetExpiryLabel,
  type AdminPasswordResetExpiryWindow,
} from "@/lib/password-reset"
import type { PasswordActionTarget } from "../_types"

interface MemberPasswordActionDialogProps {
  open: boolean
  target: PasswordActionTarget | null
  onOpenChange: (open: boolean) => void
  onComplete: (message: string) => void
  onError: (message: string) => void
}

export function MemberPasswordActionDialog({
  open,
  target,
  onOpenChange,
  onComplete,
  onError,
}: MemberPasswordActionDialogProps) {
  const [passwordActionLoading, setPasswordActionLoading] = useState(false)
  const [resetExpiryWindow, setResetExpiryWindow] = useState<AdminPasswordResetExpiryWindow>(
    DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
  )

  useEffect(() => {
    if (open) setResetExpiryWindow(DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW)
  }, [open])

  const inviteCount = target?.inviteIds.length ?? 0
  const resendInviteCount = target?.resendInviteIds.length ?? 0
  const inviteTotalCount = inviteCount + resendInviteCount
  const resetCount = target?.resetIds.length ?? 0
  const title =
    resetCount > 0 && inviteTotalCount === 0
      ? "Send Password Reset"
      : inviteTotalCount > 0 && resetCount === 0
        ? resendInviteCount > 0 && inviteCount === 0
          ? "Resend Account Setup Invite"
          : "Send Account Setup Invite"
        : "Send Login Emails"
  const buttonLabel =
    resetCount > 0 && inviteTotalCount === 0
      ? "Send Reset Email"
      : inviteTotalCount > 0 && resetCount === 0
        ? resendInviteCount > 0 && inviteCount === 0
          ? "Resend Invite"
          : "Send Invite"
        : "Send Emails"
  const description =
    inviteTotalCount > 0 && resetCount > 0
      ? `Send login emails to ${target?.label}. ${inviteCount} member(s) will receive a first-time account setup invite. ${resendInviteCount} member(s) will receive a fresh account setup invite. ${resetCount} member(s) will receive a password reset email.`
      : resetCount > 0
        ? `Send a password reset email to ${target?.label}. They will receive a link to set a new password.`
        : resendInviteCount > 0 && inviteCount === 0
          ? `Send a fresh account setup email to ${target?.label}. The current pending invite will be replaced with a new ${MEMBER_SETUP_INVITE_TTL_DAYS}-day link.`
          : `Send a first-time password setup email to ${target?.label}. They will receive a link to activate their account and choose a password (expires in ${MEMBER_SETUP_INVITE_TTL_DAYS} days).`

  const sendPasswordResetRequest = async (memberIds: string[]) => {
    const res = await fetch("/api/admin/members/send-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds, expiryWindow: resetExpiryWindow }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      sent?: number
      skipped?: number
      expiryLabel?: string
      error?: string
    }
    if (!res.ok) throw new Error(data.error || "Failed to send password reset")
    return {
      sent: data.sent ?? 0,
      skipped: data.skipped ?? 0,
      expiryLabel: data.expiryLabel ?? getAdminPasswordResetExpiryLabel(resetExpiryWindow),
    }
  }

  const sendSetupInviteRequest = async (memberIds: string[]) => {
    const res = await fetch("/api/admin/members/send-setup-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      sent?: number
      skipped?: number
      error?: string
    }
    if (!res.ok) throw new Error(data.error || "Failed to send setup invite")
    return { sent: data.sent ?? 0, skipped: data.skipped ?? 0 }
  }

  const handleSendPasswordAction = async () => {
    if (!target) return
    setPasswordActionLoading(true)

    const setupInviteIds = [...target.inviteIds, ...target.resendInviteIds]
    const inviteOperation =
      setupInviteIds.length > 0 ? sendSetupInviteRequest(setupInviteIds) : Promise.resolve(null)
    const resetOperation =
      target.resetIds.length > 0 ? sendPasswordResetRequest(target.resetIds) : Promise.resolve(null)

    const [inviteResult, resetResult] = await Promise.allSettled([
      inviteOperation,
      resetOperation,
    ])
    const successMessages: string[] = []
    const errorMessages: string[] = []

    if (inviteResult.status === "fulfilled" && inviteResult.value) {
      successMessages.push(
        inviteResult.value.skipped > 0
          ? `Sent ${inviteResult.value.sent} setup invite(s). ${inviteResult.value.skipped} skipped (inactive or non-login).`
          : `Sent ${inviteResult.value.sent} setup invite(s).`
      )
    } else if (inviteResult.status === "rejected") {
      errorMessages.push(
        inviteResult.reason instanceof Error
          ? inviteResult.reason.message
          : "Failed to send setup invite"
      )
    }

    if (resetResult.status === "fulfilled" && resetResult.value) {
      successMessages.push(
        resetResult.value.skipped > 0
          ? `Sent ${resetResult.value.sent} password reset email(s) with a ${resetResult.value.expiryLabel} window. ${resetResult.value.skipped} skipped (inactive or non-login).`
          : `Sent ${resetResult.value.sent} password reset email(s) with a ${resetResult.value.expiryLabel} window.`
      )
    } else if (resetResult.status === "rejected") {
      errorMessages.push(
        resetResult.reason instanceof Error
          ? resetResult.reason.message
          : "Failed to send password reset"
      )
    }

    if (successMessages.length > 0) {
      onComplete(successMessages.join(" "))
      onOpenChange(false)
    }

    if (errorMessages.length > 0) onError(errorMessages.join(" "))

    setPasswordActionLoading(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {resetCount > 0 && (
          <div className="space-y-2">
            <Label htmlFor="reset-expiry-window">Reset link expiry</Label>
            <Select
              value={resetExpiryWindow}
              onValueChange={(value) =>
                setResetExpiryWindow(value as AdminPasswordResetExpiryWindow)
              }
            >
              <SelectTrigger id="reset-expiry-window">
                <SelectValue placeholder="Select expiry" />
              </SelectTrigger>
              <SelectContent>
                {ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-slate-500">
              This applies to password reset emails only. The current selection expires in{" "}
              {getAdminPasswordResetExpiryLabel(resetExpiryWindow)}.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={passwordActionLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSendPasswordAction} disabled={passwordActionLoading}>
            {passwordActionLoading ? "Sending..." : buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
