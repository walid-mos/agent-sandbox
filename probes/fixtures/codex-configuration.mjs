export function codexConfiguration() {
  return {
    format: 'agent-sandbox-codex-v1',
    providers: {
      providers: [{ id: 'inco', keys: ['fixture-key'], routing: 'order', headers: { 'X-Fixture': 'kept' } }],
      accountBindings: { codex: '/fixture/original-auth.json', claude: 'fixture-account' },
      groups: [
        { id: 'router', routing: 'order', rules: [{ use: ['group/max'] }], members: ['group/expert', 'group/max'] },
        { id: 'deep', routing: 'order', members: ['codex/gpt-6.1-sol:medium#original', 'claude/opus:low', 'group/think'] },
        { id: 'expert', routing: 'order', members: ['codex/gpt-6.1-sol:high#original', 'claude/opus:high', 'group/deep'] },
        { id: 'max', routing: 'order', members: ['claude/fable:xhigh', 'group/expert'] },
      ],
    },
    settings: { images: true, tools: true, modelWires: { 'inco/deepseek-v4.1-flash:fast': 'deepseek-v4.1-flash', 'inco/glm-5.3-flash:fast': 'glm-5.3-flash' } },
    wires: { 'inco/deepseek-v4.1-flash:fast': 'deepseek-v4.1-flash', 'inco/glm-5.3-flash:fast': 'glm-5.3-flash' },
    credentials: { codex: { tokens: { access_token: 'fixture-only', account_id: 'fixture-id' } } },
  };
}
