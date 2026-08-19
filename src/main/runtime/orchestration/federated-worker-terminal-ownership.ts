export function federatedAgentTerminalWasCreated(
  effects: readonly unknown[],
  terminalHandle: string
): boolean {
  return effects.some(
    (effect) =>
      Boolean(effect) &&
      typeof effect === 'object' &&
      (effect as { kind?: string }).kind === 'terminal' &&
      (effect as { role?: string }).role === 'agent' &&
      (effect as { id?: string }).id === terminalHandle &&
      ['created', 'reused_agent_terminal'].includes((effect as { action?: string }).action ?? '')
  )
}
