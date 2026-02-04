/**
 * @blockrun/openclaw-provider
 *
 * OpenClaw plugin that adds BlockRun as an LLM provider with 30+ AI models.
 * Payments are handled automatically via x402 USDC micropayments on Base.
 * Smart routing picks the cheapest capable model for each request.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugin install @blockrun/openclaw-provider
 *
 *   # Set wallet key
 *   export BLOCKRUN_WALLET_KEY=0x...
 *
 *   # Or configure via wizard
 *   openclaw provider add blockrun
 *
 *   # Use smart routing (auto-picks cheapest model)
 *   openclaw config set model blockrun/auto
 *
 *   # Or use any specific BlockRun model
 *   openclaw config set model openai/gpt-5.2
 */

import type { OpenClawPluginDefinition, OpenClawPluginApi } from "./types.js";
import { blockrunProvider, setActiveProxy } from "./provider.js";
import { startProxy } from "./proxy.js";
import type { RoutingConfig } from "./router/index.js";

const plugin: OpenClawPluginDefinition = {
  id: "@blockrun/openclaw-provider",
  name: "BlockRun Provider",
  description: "30+ AI models with x402 micropayments — GPT-5, Claude, Gemini, DeepSeek, Grok",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    // Register BlockRun as a provider
    api.registerProvider(blockrunProvider);

    api.logger.info("BlockRun provider registered (30+ models via x402)");
  },

  async activate(api: OpenClawPluginApi) {
    // Resolve wallet key from config or env
    const walletKey = resolveWalletKey(api);
    if (!walletKey) {
      api.logger.warn(
        "BlockRun wallet key not configured. Run `openclaw provider add blockrun` or set BLOCKRUN_WALLET_KEY.",
      );
      return;
    }

    // Resolve routing config overrides from plugin config
    const routingConfig = api.pluginConfig?.routing as Partial<RoutingConfig> | undefined;

    // Start the local x402 proxy
    try {
      const proxy = await startProxy({
        walletKey,
        routingConfig,
        onReady: (port) => {
          api.logger.info(`BlockRun x402 proxy listening on port ${port}`);
        },
        onError: (error) => {
          api.logger.error(`BlockRun proxy error: ${error.message}`);
        },
        onRouted: (decision) => {
          const savingsPct = (decision.savings * 100).toFixed(1);
          const cost = decision.costEstimate.toFixed(4);
          const baseline = decision.baselineCost.toFixed(4);
          api.logger.info(
            `[routing] ${decision.model} (${decision.tier}, ${decision.method}, confidence=${decision.confidence.toFixed(2)}) ` +
            `cost=$${cost} baseline=$${baseline} saved=${savingsPct}%`,
          );
        },
      });

      setActiveProxy(proxy);
      api.logger.info(`BlockRun provider active — ${proxy.baseUrl}/v1 (smart routing enabled)`);
    } catch (err) {
      api.logger.error(
        `Failed to start BlockRun proxy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

/**
 * Resolve the wallet key from plugin config, OpenClaw config, or environment.
 */
function resolveWalletKey(api: OpenClawPluginApi): string | undefined {
  // 1. Plugin-level config
  const pluginKey = api.pluginConfig?.walletKey;
  if (typeof pluginKey === "string" && pluginKey.startsWith("0x")) {
    return pluginKey;
  }

  // 2. Environment variable
  const envKey = process.env.BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x")) {
    return envKey;
  }

  // 3. Provider auth profile credential (stored by `openclaw provider add blockrun`)
  const providerConfig = api.config?.models?.providers?.blockrun;
  if (providerConfig && typeof providerConfig.apiKey === "string" && providerConfig.apiKey.startsWith("0x")) {
    return providerConfig.apiKey;
  }

  return undefined;
}

export default plugin;

// Re-export for programmatic use
export { startProxy } from "./proxy.js";
export { blockrunProvider } from "./provider.js";
export { OPENCLAW_MODELS, BLOCKRUN_MODELS, buildProviderModels } from "./models.js";
export { route, DEFAULT_ROUTING_CONFIG } from "./router/index.js";
export type { RoutingDecision, RoutingConfig, Tier } from "./router/index.js";
export { logUsage } from "./logger.js";
export type { UsageEntry } from "./logger.js";
