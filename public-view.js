// Public-mode shaping (#57). While the dashboard is reachable without login,
// responses must not reveal internal URLs, raw actuator bodies or errors, and
// public traffic must not trigger live checks against the services.
// Authorised (full) access comes with Keycloak in #58.

export function isPublicMode(env = process.env) {
  return String(env.ORISO_PUBLIC_MODE ?? 'true').toLowerCase() !== 'false';
}

// Collapses a checkService() result to the only value public users see.
export function publicStatus(result) {
  if (!result) return 'UNKNOWN';
  if (result.up) return 'UP';
  if (String(result.body?.status || '').toUpperCase() === 'DEGRADED') return 'DEGRADED';
  return 'DOWN';
}

// Display names only: no URLs or other config fields.
export function publicServices(services) {
  return Object.fromEntries(
    Object.entries(services).map(([key, svc]) => [key, { name: svc?.name || key }])
  );
}

// Answer from the last scheduled run, never a live check.
export function publicHealth(latest) {
  return {
    status: latest?.status || 'UNKNOWN',
    checkedAt: latest?.checkedAt || null
  };
}
