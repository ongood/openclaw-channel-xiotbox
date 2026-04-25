# XiotBox Digital Employee Permission Model

This document defines the recommended default permission model for XiotBox-backed
OpenClaw digital employees. The goal is to make useful autonomy possible without
turning every employee into an unrestricted shell operator.

## Design Principles

- Separate job role from security boundary. A role prompt may say "engineer",
  but the enforceable boundary comes from OpenClaw agent tools, exec policy,
  XiotBox scopes, control actions, and approval rules.
- Default to least privilege. Start with read/search capabilities and add write,
  exec, or device-control access only where the employee's job requires it.
- Prefer allowlists over broad approvals. `ask=off` is acceptable only for
  private lab deployments or tightly scoped automation hosts.
- Keep production and physical-device actions human-gated. An approval steward
  can classify and recommend, but should not silently approve high-risk actions.
- Make policy visible in the client. XiotBox client roles should show
  permission profile, risk level, approval mode, allowed tools, and control
  actions so operators can see what an employee is allowed to do.

## Default Role Matrix

| Role | Permission Profile | Risk | Approval | Recommended Tools | Notes |
| --- | --- | --- | --- | --- | --- |
| Chief Coordinator | `planner` | low | `none` | `web_search`, `web_fetch` | Plans work and routes tasks. No host mutation. |
| Research Analyst | `researcher` | low | `none` | `read`, `web_search`, `web_fetch` | Reads context and researches. No shell mutation. |
| Implementation Engineer | `builder` | high | `allowlist` | `read`, `write`, `edit`, `exec`, `process`, `web_search`, `web_fetch` | Writes code and runs checks within allowlisted commands. |
| Backend Engineer | `builder` | high | `allowlist` | same as builder | Backend/API/data work. Service-impacting commands need approval. |
| Frontend Engineer | `builder` | high | `allowlist` | same as builder | UI/state work. Destructive edits need approval. |
| QA Reviewer | `reviewer` | medium | `none` | `read`, `exec`, `process`, `web_search`, `web_fetch` | Runs tests and reviews risk. Should not mutate product files. |
| Security Reviewer | `security` | medium | `none` | `read`, `process`, `web_search`, `web_fetch` | Audits secrets, auth, policies, and attack surface. |
| SRE Operator | `operator` | high | `allowlist` | `read`, `exec`, `process` | Reads logs/status and runs scoped operational commands. |
| Device Operator | `device_control` | critical | `human` | `xiotbox_control` | Controls mobile/desktop devices through explicit action allowlists. |
| Release Manager | `release` | critical | `human` | `read`, `write`, `edit`, `exec`, `process` | Coordinates build/tag/deploy/rollback. Release actions stay gated. |

## OpenClaw Agent Baseline

For a single-machine trusted employee, keep one `main` agent with explicit tools:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "allow": [
            "read",
            "write",
            "edit",
            "exec",
            "process",
            "web_search",
            "web_fetch",
            "xiotbox_control"
          ]
        }
      }
    ]
  },
  "tools": {
    "exec": {
      "host": "auto",
      "security": "allowlist",
      "ask": "on-miss",
      "applyPatch": {
        "workspaceOnly": true
      }
    }
  }
}
```

For a first-class multi-employee deployment, prefer separate OpenClaw agents:

```json
{
  "agents": {
    "list": [
      {
        "id": "chief",
        "tools": { "allow": ["web_search", "web_fetch"] }
      },
      {
        "id": "researcher",
        "tools": { "allow": ["read", "web_search", "web_fetch"] }
      },
      {
        "id": "builder",
        "tools": {
          "allow": ["read", "write", "edit", "exec", "process", "web_search", "web_fetch"]
        }
      },
      {
        "id": "qa",
        "tools": { "allow": ["read", "exec", "process", "web_search", "web_fetch"] }
      },
      {
        "id": "security",
        "tools": { "allow": ["read", "process", "web_search", "web_fetch"] }
      },
      {
        "id": "sre",
        "tools": { "allow": ["read", "exec", "process"] }
      },
      {
        "id": "device_operator",
        "tools": { "allow": ["xiotbox_control"] }
      },
      {
        "id": "release",
        "tools": { "allow": ["read", "write", "edit", "exec", "process"] }
      }
    ]
  }
}
```

## XiotBox Thread To Agent Binding

XiotBox should route each employee thread to the narrowest OpenClaw agent that
can do the job. The plugin now builds canonical session keys in this shape:

```text
agent:<agentId>:xiotbox:<deviceId>:<threadId>
```

That lets OpenClaw enforce `agents.list[].tools.allow` per employee instead of
running every XiotBox conversation through the broad `main` agent.

Recommended channel mapping:

```json
{
  "channels": {
    "xiotbox": {
      "SESSION_AGENT_ID": "main",
      "SESSION_AGENT_MAP": {
        "chief_engineer": "chief",
        "researcher": "researcher",
        "fullstack_dev": "builder",
        "backend_dev": "builder",
        "frontend_dev": "builder",
        "qa_reviewer": "qa",
        "security_reviewer": "security",
        "sre_operator": "sre",
        "device_operator": "device_operator",
        "release_manager": "release",
        "*": "main"
      }
    }
  }
}
```

The left side should match the XiotBox thread or role id. The right side should
match an OpenClaw agent id from `agents.list`. Keep `SESSION_AGENT_ID` as a safe
fallback for unknown threads.

## Exec Policy Baselines

Recommended production-like baseline:

```bash
openclaw exec-policy set --host auto --security allowlist --ask on-miss
```

For a trusted private lab only:

```bash
openclaw exec-policy set --host auto --security full --ask off
```

When approvals appear, prefer persistent allowlist approvals for low-risk,
repeatable commands:

```bash
openclaw approvals get --gateway
openclaw exec-policy show
```

Do not build a blanket approval bot that approves every pending request. If an
approval employee exists, limit it to low-risk classes such as read-only
diagnostics, known test commands, and fixed workspace operations.

## XiotBox Control Actions

The OpenClaw host bot should default to chat scope only:

```json
{
  "channels": {
    "xiotbox": {
      "SCOPES": ["chat"],
      "CONTROL_ACTIONS": []
    }
  }
}
```

The device that actually performs UI control, such as the Android XiotBox
Control Agent, should expose a narrow control set:

```json
{
  "SCOPES": ["control"],
  "CONTROL_ACTIONS": [
    "get_screen",
    "get_tree",
    "wait_ui_change",
    "tap",
    "click_text",
    "type",
    "swipe"
  ]
}
```

Keep camera, microphone, notification reading, accessibility settings, and
long-running recording actions outside the default allowlist. Promote them only
for a specific role and a specific operational reason.

## Client Responsibilities

The XiotBox client should treat role policy as operator-visible state:

- `permission_profile`: role security profile, such as `builder` or `device_control`.
- `risk_level`: `low`, `medium`, `high`, or `critical`.
- `approval_mode`: `none`, `allowlist`, or `human`.
- `allowed_tool_ids`: the OpenClaw tools expected by the role.
- `control_action_ids`: the XiotBox control actions expected by the role.
- `policy_summary`: one human-readable sentence explaining the boundary.

These fields do not replace OpenClaw enforcement. They make the operator UI,
role prompts, and deployment policy agree with the real runtime controls.

## Operational Checklist

Before enabling a digital employee group:

1. Confirm each role has a permission profile and approval mode.
2. Confirm OpenClaw `agents.list[].tools.allow` contains only the tools the
   bound agent should expose.
3. Confirm `openclaw exec-policy show` matches the intended autonomy level.
4. Confirm XiotBox device-control agents expose only required
   `CONTROL_ACTIONS`.
5. Confirm logs are available:
   `journalctl -u openclaw-gateway -f`, `openclaw logs --follow`, and gateway
   container logs if deployed through Docker.
6. Confirm release and production-impacting operations still have a human gate.
