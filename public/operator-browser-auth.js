import Keycloak from './vendor/keycloak/keycloak.js';

export async function startOperatorAuth(login, dashboardUrl, onLogout) {
  const keycloak = new Keycloak(login);
  const callbackUrl = new URL('auth/callback', dashboardUrl).href;
  keycloak.onAuthLogout = onLogout;
  keycloak.onTokenExpired = () => keycloak.clearToken();

  await keycloak.init({
    flow: 'standard',
    pkceMethod: 'S256',
    responseMode: 'fragment',
    checkLoginIframe: false,
    logoutMethod: 'POST',
    redirectUri: callbackUrl
  });

  return {
    headers: () => keycloak.token ? { Authorization: `Bearer ${keycloak.token}` } : {},
    login: () => keycloak.login({ redirectUri: callbackUrl }),
    logout: () => keycloak.logout({ redirectUri: dashboardUrl.href })
  };
}
