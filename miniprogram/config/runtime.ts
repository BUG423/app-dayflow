import { configureSync, getSyncState } from '../services/sync';
import { getPreferences, savePreferences } from '../services/preferences';

// Publisher-only build configuration. Public source must keep empty values.
export const runtimeConfiguration = { cloudEnvId: '', subscriptionTemplateIds: ['', ''] as string[] };
export function initializeRuntimeSettings(): void {
  const config = runtimeConfiguration;
  if (config.cloudEnvId) {
    const previous = getSyncState();
    configureSync({ envId: config.cloudEnvId, enabled: previous.envId === config.cloudEnvId && previous.enabled });
  }
  if (config.subscriptionTemplateIds.some(id => !!id)) {
    const current = getPreferences();
    if (JSON.stringify(current.subscriptionTemplateIds) !== JSON.stringify(config.subscriptionTemplateIds)) {
      savePreferences({ subscriptionTemplateIds: [...config.subscriptionTemplateIds] });
    }
  }
}
