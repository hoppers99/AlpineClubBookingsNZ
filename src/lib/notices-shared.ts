// Shared notice constants safe to import from client components
// (no server-only imports here).

export const NOTICE_TITLE_MAX_LENGTH = 200;
// Generous ceiling for authored HTML; the same order of magnitude as the CMS
// page-content limit. Sanitisation runs on top of this.
export const NOTICE_BODY_MAX_LENGTH = 50_000;
