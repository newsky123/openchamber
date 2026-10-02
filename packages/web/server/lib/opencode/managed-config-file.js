import { parse as parseJsonc } from 'jsonc-parser';
import { agentToolSettingsSchema } from '../agent-tool/catalog.js';

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

/**
 * Data-only settings for the adapter compiled into OpenCode. This file never
 * names a plugin, contains source code, or stores the private callback token.
 * Existing user and project configuration remains on disk unchanged.
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  dataDir,
  env = process.env,
  readSettings,
  isAgentMemoryAvailable,
}) => {
  const filePath = path.join(dataDir, MANAGED_CONFIG_FILE_NAME);
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;
  const toolSettings = async () => {
    const parsed = agentToolSettingsSchema.safeParse(await readSettings());
    if (!parsed.success) {
      throw new Error('OpenChamber tool settings are unavailable');
    }
    const settings = parsed.data;
    return {
      control: settings.agentControlToolEnabled !== false,
      web: settings.agentWebToolEnabled !== false,
      memory: isAgentMemoryAvailable() && settings.agentMemoryToolEnabled === true,
      notify: settings.agentNotifyToolEnabled === true,
      codeMode: settings.agentToolsCodeMode === true,
    };
  };
  const writeConfigFile = async () => {
    const text = `${JSON.stringify({ openchamber: { agentTools: await toolSettings() } }, null, 2)}\n`;
    await fsPromises.mkdir(dataDir, { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };
  const buildManagedChildEnv = async () => {
    if (ownsConfigFile()) {
      await writeConfigFile();
      return { OPENCODE_CONFIG: filePath };
    }
    const errors = [];
    const source = (env.OPENCODE_CONFIG_CONTENT ?? '').trim();
    const content = source ? parseJsonc(source, errors, { allowTrailingComma: true }) : {};
    if (errors.length || !content || Object.getPrototypeOf(content) !== Object.prototype
      || (content.openchamber !== undefined && (!content.openchamber || Object.getPrototypeOf(content.openchamber) !== Object.prototype))) {
      throw new Error('OPENCODE_CONFIG_CONTENT must contain a valid JSON object for compiled OpenChamber tools');
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...content,
      openchamber: { ...content.openchamber, agentTools: await toolSettings() },
    }) };
  };
  const refreshManagedConfigFile = async () => {
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeConfigFile();
    return { updated: true };
  };
  return { filePath, ownsConfigFile, buildManagedChildEnv, refreshManagedConfigFile };
};
