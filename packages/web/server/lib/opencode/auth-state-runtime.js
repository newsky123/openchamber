export const createOpenCodeAuthStateRuntime = (dependencies) => {
  const { state, syncToHmrState } = dependencies;

  // The managed child owns generation. Keep the returned credential in runtime
  // memory only, including during HMR. Never publish it through process.env.
  const setManagedOpenCodePassword = (password) => {
    state.openCodeAuthPassword = password || null;
    state.openCodeAuthSource = 'managed';
    syncToHmrState();
  };

  const getOpenCodeAuthHeaders = () => {
    const password = state.openCodeAuthPassword;
    if (!password) {
      if (state.openCodeAuthSource === 'managed') throw new Error('Managed OpenCode authentication is not ready.');
      return {};
    }
    return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  };

  const isOpenCodeConnectionSecure = () => Boolean(state.openCodeAuthPassword);

  return { getOpenCodeAuthHeaders, isOpenCodeConnectionSecure, setManagedOpenCodePassword };
};
