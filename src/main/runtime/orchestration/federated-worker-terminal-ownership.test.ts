import { describe, expect, it } from 'vitest'
import { federatedAgentTerminalWasCreated } from './federated-worker-terminal-ownership'

describe('federated agent terminal ownership', () => {
  it('requires the created effect to name the exact agent terminal', () => {
    const effects = [
      { kind: 'terminal', role: 'setup', action: 'created', id: 'term_setup' },
      { kind: 'terminal', role: 'configured_tab', action: 'created', id: 'term_extra' },
      { kind: 'terminal', role: 'agent', action: 'reused', id: 'term_agent' }
    ]

    expect(federatedAgentTerminalWasCreated(effects, 'term_agent')).toBe(false)
    expect(
      federatedAgentTerminalWasCreated(
        [...effects, { kind: 'terminal', role: 'agent', action: 'created', id: 'term_other' }],
        'term_agent'
      )
    ).toBe(false)
    expect(
      federatedAgentTerminalWasCreated(
        [...effects, { kind: 'terminal', role: 'agent', action: 'created', id: 'term_agent' }],
        'term_agent'
      )
    ).toBe(true)
  })
})
