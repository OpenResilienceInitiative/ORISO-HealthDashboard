import { createRemoteJWKSet, jwtVerify } from 'jose';

const inventoryRole = 'view-helm-images';
const anonymous = { authenticated: false, canViewHelmImages: false };

function readLoginConfig(env) {
  const issuer = env.ORISO_DASHBOARD_OIDC_ISSUER;
  const clientId = env.ORISO_DASHBOARD_OIDC_CLIENT_ID;
  if (typeof issuer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(clientId ?? '')) {
    return null;
  }

  let address;
  try {
    address = new URL(issuer);
  } catch {
    return null;
  }
  if (address.protocol !== 'https:' ||
      address.username || address.password || address.search || address.hash ||
      address.href !== issuer) {
    return null;
  }

  const realmPath = /^((?:\/[A-Za-z0-9._-]+)*)\/realms\/([A-Za-z0-9._-]+)$/.exec(address.pathname);
  if (!realmPath) return null;
  const [, authPath, realm] = realmPath;
  return { issuer, clientId, url: address.origin + authPath, realm };
}

export function createOperatorAuth(env = process.env) {
  const settings = readLoginConfig(env);
  const login = settings && { url: settings.url, realm: settings.realm, clientId: settings.clientId };
  const keySet = settings && createRemoteJWKSet(new URL(settings.issuer + '/protocol/openid-connect/certs'));

  return {
    async session(authorization) {
      const bearer = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization ?? '');
      if (!keySet || !bearer) return { login, ...anonymous };

      try {
        const { payload } = await jwtVerify(bearer[1], keySet, {
          algorithms: ['RS256'],
          issuer: settings.issuer,
          audience: settings.clientId,
          requiredClaims: ['exp', 'sub', 'azp', 'typ']
        });
        if (payload.azp !== settings.clientId || payload.typ !== 'Bearer') return { login, ...anonymous };
        const roles = payload.resource_access?.[settings.clientId]?.roles;
        return {
          login,
          authenticated: true,
          canViewHelmImages: Array.isArray(roles) && roles.includes(inventoryRole)
        };
      } catch {
        return { login, ...anonymous };
      }
    }
  };
}
