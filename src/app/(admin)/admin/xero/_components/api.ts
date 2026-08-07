"use client"

type ErrorBody = {
  error?: string
  message?: string
  warning?: string
}

export const XERO_ACTION_NETWORK_ERROR =
  "The service could not be reached. Your selections are still here. Check the current status, then try again."

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function readOptionalJson<T>(res: Response, fallback: T): Promise<T> {
  try {
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const data = await readOptionalJson<ErrorBody | null>(res, null)
  return data?.error || data?.message || fallback
}

export async function fetchJson<T>(url: string, options?: RequestInit, fallbackMessage = "Request failed"): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, options)
  } catch {
    throw new Error(XERO_ACTION_NETWORK_ERROR)
  }
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, fallbackMessage))
  }
  return readJson<T>(res)
}

export async function postJson<T>(url: string, body?: unknown, fallbackMessage = "Request failed"): Promise<T> {
  return fetchJson<T>(
    url,
    {
      method: "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    fallbackMessage
  )
}

export type ActionResponse = {
  message?: string
  warning?: string
  memberId?: string
  memberFirstName?: string
  memberLastName?: string
  memberEmail?: string
  active?: boolean
  xeroContactId?: string
}
