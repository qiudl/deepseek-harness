import { describe, expect, it } from 'vitest'
import { auditSlarkCloudComposition, slarkCloudPresetSnapshot } from './verify-slark-cloud-preset.ts'

describe('slark-cloud composition gate', () => {
  it('accepts the shipped cloud composition', () => {
    expect(auditSlarkCloudComposition()).toEqual([])
  })

  it('snapshots the real keyless model surface and remote provider boundary', () => {
    expect(slarkCloudPresetSnapshot()).toMatchInlineSnapshot(`
      {
        "persona": "You are the user's DeepSeek Harness personal-workbench agent. File and Shell operations run only through the selected Slark Desktop device and its active Workspace Grant. If the device or Grant is unavailable, report that state; never claim the cloud Runtime Cell is the user's computer.",
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
          "slark-cloud-ingress=@deepseek-ai/dsh-slark-cloud",
          "slark-device=@deepseek-ai/dsh-slark-device-client",
          "slark-identity=@deepseek-ai/dsh-slark-identity",
          "slark-fs=@deepseek-ai/dsh-fs-slark-remote",
          "slark-shell=@deepseek-ai/dsh-shell-slark-remote",
        ],
      }
    `)
  })
})
