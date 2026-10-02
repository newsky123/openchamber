import { describe, expect, test } from 'bun:test';
import { getSettingsPageMeta, resolveSettingsSlug, SETTINGS_PAGE_METADATA } from './metadata';

describe('retired plugin settings navigation', () => {
  test('old persisted navigation resolves to the Settings root', () => {
    for (const value of ['plugins', ' Plugins ', 'PLUGINS']) {
      expect(resolveSettingsSlug(value)).toBe('home');
    }
    expect(getSettingsPageMeta('plugins')).toBeNull();
    expect(SETTINGS_PAGE_METADATA.map((page) => page.slug)).not.toContain('plugins');
  });

  test('MCP, agents, commands and OpenChamber SDK Extensions remain available', () => {
    for (const slug of ['mcp', 'agents', 'commands', 'extensions'] as const) {
      expect(resolveSettingsSlug(slug)).toBe(slug);
      expect(getSettingsPageMeta(slug)?.slug).toBe(slug);
    }
  });
});
