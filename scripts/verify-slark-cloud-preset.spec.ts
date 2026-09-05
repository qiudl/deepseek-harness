import { describe, expect, it } from 'vitest'
import {
  auditSlarkCloudComposition,
  slarkCloudPresetSnapshot,
  slarkCloudRolloutSnapshot,
} from './verify-slark-cloud-preset.ts'

describe('slark-cloud composition gate', () => {
  it('accepts the shipped cloud composition', () => {
    expect(auditSlarkCloudComposition()).toEqual([])
  })

  it('snapshots the real keyless model surface and remote provider boundary', () => {
    expect(slarkCloudPresetSnapshot()).toMatchInlineSnapshot(`
      {
        "persona": "process.env.WEB_DSH_LOCAL_COMPUTER_V1 === '1' ? \"You are the user's DeepSeek Harness personal-workbench agent. File operations run only through the explicitly selected Slark Desktop device and its active Workspace Grant. Shell and process execution are unavailable in this Web profile. If the device or Grant is unavailable, report that state; never claim the cloud Runtime Cell is the user's computer.\" : \"You are the user's DeepSeek Harness personal-workbench agent. File and Shell operations run only through the selected Slark Desktop device and its active Workspace Grant. If the device or Grant is unavailable, report that state; never claim the cloud Runtime Cell is the user's computer.\"",
        "presetRows": [
          "persona=@deepseek-ai/dsh-persona",
          "agent-instructions=@deepseek-ai/dsh-agent-instructions",
          "tool-bash=@deepseek-ai/dsh-tool-bash",
          "tool-fs=@deepseek-ai/dsh-tool-fs",
          "tool-jobs=@deepseek-ai/dsh-tool-jobs",
          "skill-filesystem=@deepseek-ai/dsh-skill-filesystem",
          "tool-skill=@deepseek-ai/dsh-tool-skill",
          "tool-goal=@deepseek-ai/dsh-tool-goal",
          "planning=cordis:group",
          "plan-mode=@deepseek-ai/dsh-plan-mode",
          "compaction=cordis:group",
          "compaction-basic=@deepseek-ai/dsh-compaction-basic",
          "command-compact=@deepseek-ai/dsh-command-compact",
          "tool-result-pruner=@deepseek-ai/dsh-compaction-tool-result-pruner",
          "delegation=cordis:group",
          "tool-subagent-control=@deepseek-ai/dsh-tool-subagent-control",
          "tool-subagent-list-agents=@deepseek-ai/dsh-tool-subagent-control/list-agents",
          "tool-subagent=@deepseek-ai/dsh-tool-subagent",
          "tool-subagent-fork=@deepseek-ai/dsh-tool-subagent",
          "workflow-worker-thread=@deepseek-ai/dsh-workflow-worker-thread",
          "tool-workflow=@deepseek-ai/dsh-tool-workflow",
          "tool-ralph=@deepseek-ai/dsh-tool-ralph",
          "tool-ask-user=@deepseek-ai/dsh-tool-ask-user",
          "tool-todo=@deepseek-ai/dsh-tool-todo",
          "tool-web=@deepseek-ai/dsh-tool-web",
        ],
        "providerRows": [
          "slark-local-collaboration=@deepseek-ai/dsh-slark-local-collaboration",
          "slark-cloud-ingress=@deepseek-ai/dsh-slark-cloud",
          "slark-device=@deepseek-ai/dsh-slark-device-client",
          "slark-identity=@deepseek-ai/dsh-slark-identity",
          "slark-collaboration-network=@deepseek-ai/dsh-slark-collaboration-network",
          "slark-fs=@deepseek-ai/dsh-fs-slark-remote",
          "slark-local-computer-ui=@deepseek-ai/dsh-client-ui-slark-local-computer",
          "slark-shell=@deepseek-ai/dsh-shell-slark-remote",
        ],
      }
    `)
  })

  it('keeps legacy v1 intact while the independent Web rollout is off', () => {
    for (const value of [undefined, '0']) {
      const snapshot = slarkCloudRolloutSnapshot(value)
      expect(snapshot.activeProviderRows).toEqual([
        'slark-device', 'slark-identity', 'slark-fs', 'slark-shell',
      ])
      expect(snapshot.activePermissionRows).toEqual(['permission', 'ui-permission'])
      expect(snapshot.callerProfiles).toEqual([undefined, undefined])
      expect(snapshot.activePresetRows).toEqual(expect.arrayContaining(['tool-bash', 'tool-fs', 'tool-jobs']))
      expect(snapshot.persona).toContain('File and Shell operations')
    }
  })

  it('switches the complete Web surface atomically to file-only v2', () => {
    const snapshot = slarkCloudRolloutSnapshot('1')
    expect(snapshot.activeProviderRows).toEqual([
      'slark-device', 'slark-identity', 'slark-fs', 'slark-local-computer-ui',
    ])
    expect(snapshot.activePermissionRows).toEqual([])
    expect(snapshot.callerProfiles).toEqual(['web_dsh_v1', 'web_dsh_v1'])
    expect(snapshot.activePresetRows).toContain('tool-fs')
    expect(snapshot.activePresetRows).not.toEqual(expect.arrayContaining(['tool-bash', 'tool-jobs']))
    expect(snapshot.persona).toContain('Shell and process execution are unavailable')
  })

  it('fails boot evaluation instead of treating an invalid Web flag as legacy Shell', () => {
    expect(() => slarkCloudRolloutSnapshot('true')).toThrow(
      'WEB_DSH_LOCAL_COMPUTER_V1 must be exactly 0 or 1',
    )
  })
})
