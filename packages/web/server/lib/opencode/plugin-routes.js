/** Keep retired routes explicit so requests cannot fall through to OpenCode. */
export const registerPluginRoutes = (app) => {
  app.use('/api/config/plugins', (_req, res) => res.status(501).json({
    error: 'Dynamic OpenCode plugin configuration is unavailable.',
    code: 'dynamic_plugins_unavailable',
  }));
};
