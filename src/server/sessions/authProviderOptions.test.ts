import { describe, expect, it } from "vitest";
import { getLoginProviderOptions, getLogoutProviderOptions, type AuthProviderRuntime } from "./authProviderOptions";

function runtime(): AuthProviderRuntime {
  const credentials = [{ providerId: "openai", type: "api_key" as const }];
  // Auth shapes mirror what the Pi SDK actually reports for these providers:
  // github-copilot supports both methods, openai-codex is OAuth-only, and
  // ambient providers resolve credentials without offering interactive login.
  const providers = [
    { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: { login: () => undefined } } },
    { id: "github-copilot", name: "GitHub Copilot", auth: { oauth: {}, apiKey: { login: () => undefined } } },
    { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", auth: { oauth: {} } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { login: () => undefined } } },
    { id: "custom", name: "Custom", auth: { apiKey: { login: () => undefined } } },
    { id: "ambient", name: "Ambient credentials", auth: { apiKey: {} } },
  ];
  return {
    getProviders: () => providers,
    listCredentials: () => Promise.resolve(credentials),
    getProviderAuthStatus: (provider: string) => (provider === "openai" ? { configured: true, source: "stored" } : { configured: false }),
  };
}

describe("auth provider options", () => {
  it("offers each interactive login method reported by the backend", () => {
    const options = getLoginProviderOptions(runtime());
    expect(options).toEqual(expect.arrayContaining([
      // Dual-capable providers surface both login methods, driven purely by SDK data.
      expect.objectContaining({ id: "anthropic", authType: "oauth" }),
      expect.objectContaining({ id: "anthropic", authType: "api_key" }),
      expect.objectContaining({ id: "github-copilot", authType: "oauth" }),
      expect.objectContaining({ id: "github-copilot", authType: "api_key" }),
      // OAuth-only provider surfaces only oauth.
      expect.objectContaining({ id: "openai-codex", authType: "oauth" }),
      // API-key-only providers surface only api_key.
      expect.objectContaining({ id: "openai", authType: "api_key", status: { configured: true, source: "stored" } }),
      expect.objectContaining({ id: "custom", authType: "api_key" }),
    ]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "openai-codex", authType: "api_key" })]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "openai", authType: "oauth" })]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "ambient", authType: "api_key" })]));
  });

  it("returns only currently stored credentials for logout", async () => {
    expect(await getLogoutProviderOptions(runtime())).toEqual([
      expect.objectContaining({ id: "openai", authType: "api_key" }),
    ]);
  });
});
