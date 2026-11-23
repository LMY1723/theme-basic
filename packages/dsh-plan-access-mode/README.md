# dsh-plan-access-mode

Adds a **Plan mode** to the DeepSeek Harness access-mode dropdown.

When selected:

- the session switches to a read-only sandbox (`approval: never`, no escalation);
- the official plan mode (`/plan`) is activated automatically;
- the agent researches read-only and must submit a plan through `exit_plan_mode`;
- **Approve** restores the access mode you had before entering Plan mode and starts implementation;
- switching to another access mode while planning exits plan mode and keeps your new choice.

The dropdown item carries a lightbulb icon and a short description. The plugin also ships the permission presets used by the dropdown:

| Mode | Behavior |
|---|---|
| Read only | read-only sandbox, escalation asks |
| Workspace write | workspace writes, wider access asks |
| Full access | no sandbox, no approval prompts |
| Plan | read-only, no escalation, `/plan` + plan review |

## How it works

- `lib/index.js` — host bridge: keeps the `plan` permission preset and `/plan` state in sync, restores the previous preset on exit, and adds a host prompt section while planning.
- `lib/client.js` — a modified copy of the official MIT `@deepseek-ai/dsh-client-ui-permission-presets` client bundle that adds the `plan` lightbulb glyph and the two-line option label. It replaces the official `ui-permission` row (`cordis.patch.yml` disables that row).
- `cordis.patch.yml` — registers the four permission presets, disables the official `ui-permission` row, and mounts this plugin.

`lib/client.js` is derived from the official client bundle; see `NOTICE` for attribution and the list of changes.

## Requirements

- DeepSeek Harness `>=0.2.0-0 <0.3.0-0`.
- The selected agent preset must mount the official `@deepseek-ai/dsh-plan-mode` (the shipped `standard`, `ptc`, `cordis`, and the community redteam/unrestricted presets do; `minimal` does not).

## Install

This package is distributed from GitHub only (no npm package).

From the in-app **Plugins** page, install the GitHub source:

```
github:LMY1723/theme-basic
```

If the package lives in a subdirectory:

```
github:LMY1723/theme-basic#path:/packages/dsh-plan-access-mode
```

Or install the prebuilt release tarball:

```
https://github.com/LMY1723/theme-basic/releases/download/v0.1.0/dsh-plan-access-mode-0.1.0.tgz
```

CLI form:

```sh
dsh plugin --profile <profile> add github:LMY1723/theme-basic
```

After installing, fully quit and restart the process serving the profile.

> Do not install this package together with another plugin that also replaces the official `ui-permission` row; both would register the same slot and patch the same row.

## Usage

1. Open the access-mode dropdown and select **Plan**.
2. Ask the agent to investigate; it stays read-only.
3. When it calls `exit_plan_mode`, review the plan and click **Approve**.
4. The access mode returns to the previous preset and implementation can start.

New sessions default to Plan mode (`defaultPreset: plan` in the bundle patch). Change it in **Settings → General → Default permission** if you prefer another default. If changing the default writes a profile `permission` row, keep the `plan` preset in that row.

## Limitations

- MCP servers that write outside the sandbox are not stopped by Plan mode.
- Shell is read-only: commands that write (for example `git status` refreshing `.git/index`) may be denied; `git diff`, `git log`, `dir`, and reads work.
- The client half is a copy of the official permission menu; a future DSH client API change may require updating `lib/client.js`.

## Uninstall

Remove the bundle and dependency from the profile, then restart. If you want the official permission menu back, remove the `ui-permission` disable from the plugin's patch (or stop using the plugin).

## License

MIT. Third-party attribution and the modifications to the official client bundle are in `NOTICE`.
