// Single source of truth for who counts as an admin. Previously this
// list was duplicated in App.jsx and Settings.jsx separately (a risk
// flagged early on -- easy for the two copies to drift). Not a real
// roles system, just a hardcoded allowlist; fine for one admin,
// revisit if that changes.
export const ADMIN_EMAILS = ['fromdevanshu@gmail.com']
