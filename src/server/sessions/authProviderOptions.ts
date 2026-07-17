import type { AuthProviderOption, AuthProviderStatus, AuthType } from "../../shared/apiTypes.js";

/** Minimal provider shape needed to enumerate login/logout options. */
interface AuthProviderInfo {
  id: string;
  name: string;
  auth: { apiKey?: { login?: unknown }; oauth?: unknown };
}

/** Non-secret stored-credential metadata, keyed by provider id. */
interface AuthProviderCredentialInfo {
  providerId: string;
  type: AuthType;
}

/**
 * Structural slice of the SDK `ModelRuntime` used to derive auth provider
 * options. Kept structural (rather than `Pick<ModelRuntime, ...>`) so tests can
 * supply a lightweight double without constructing a full runtime; a real
 * `ModelRuntime` satisfies it.
 */
export interface AuthProviderRuntime {
  getProviders(): readonly AuthProviderInfo[];
  listCredentials(): Promise<readonly AuthProviderCredentialInfo[]>;
  getProviderAuthStatus(providerId: string): AuthProviderStatus;
}

export function getLoginProviderOptions(runtime: AuthProviderRuntime, authType?: AuthType): AuthProviderOption[] {
  const providers = runtime.getProviders();

  const options: AuthProviderOption[] = [];
  for (const provider of providers) {
    if (provider.auth.oauth === undefined) continue;
    options.push({
      id: provider.id,
      name: provider.name,
      authType: "oauth",
      status: runtime.getProviderAuthStatus(provider.id),
    });
  }

  for (const provider of providers) {
    if (provider.auth.apiKey?.login === undefined) continue;
    options.push({
      id: provider.id,
      name: provider.name,
      authType: "api_key",
      status: runtime.getProviderAuthStatus(provider.id),
    });
  }

  return filterAndSort(options, authType);
}

export async function getLogoutProviderOptions(runtime: AuthProviderRuntime): Promise<AuthProviderOption[]> {
  const providerNames = new Map(runtime.getProviders().map((provider) => [provider.id, provider.name]));
  const options: AuthProviderOption[] = [];
  for (const credential of await runtime.listCredentials()) {
    options.push({
      id: credential.providerId,
      name: providerNames.get(credential.providerId) ?? credential.providerId,
      authType: credential.type,
      status: runtime.getProviderAuthStatus(credential.providerId),
    });
  }
  return filterAndSort(options);
}

function filterAndSort(options: AuthProviderOption[], authType?: AuthType): AuthProviderOption[] {
  const filtered = authType === undefined ? options : options.filter((option) => option.authType === authType);
  return filtered.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType) || a.id.localeCompare(b.id));
}
