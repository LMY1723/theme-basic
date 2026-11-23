/**
 * dsh-plan-access-mode — makes the host permission preset `plan` a real
 * "计划模式" entry in the Web composer's access-mode menu.
 *
 * The picker lists every configured `@deepseek-ai/dsh-permission-presets`
 * preset, so the `permission` row in `cordis.patch.yml` adds a fourth entry:
 *
 *   plan: { sandbox: read-only, approval: never, name: 计划模式 }
 *
 * Selecting it only changes the sandbox knobs; this plugin connects that
 * preset to the official plan mode (`@deepseek-ai/dsh-plan-mode`):
 *
 *   - selecting 计划模式 runs `/plan` for that agent;
 *   - entering plan mode by `/plan`, the command menu, or the official chip
 *     switches the session to the `plan` preset (read-only + no escalation);
 *   - leaving by the chip, `/plan off`, or `exit_plan_mode` approval restores
 *     the last non-plan preset;
 *   - switching to another access mode while planning runs `/plan off` and
 *     keeps the newly selected mode.
 *
 * The plan preset itself is the hard limit: its read-only sandbox blocks file
 * and shell writes, and `approval: never` rejects escalation. Delegated
 * subagents inherit the parent's explicit sandbox override, so they stay
 * read-only too.
 *
 * All synchronizing actions are deferred out of `session/event` publication:
 * DSH rejects an append reentered while the acceptance/publication boundary is
 * open. Event sequence numbers decide whether the latest intent was "select
 * plan" or "leave plan", which makes the reconciliation idempotent and safe
 * across restarts (the fold lives in the session log).
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-plan-access-mode'

export const inject = ['systemPrompt', 'commands', 'permissionPresets', 'agents']

const PLAN_PRESET = 'plan'
const FALLBACK_PRESET = 'danger-full-access'

/** Load/transition trail for diagnosing the bridge without the UI. */
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plan-access-mode.log')

function mark(text) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} pid=${process.pid} ${text}\n`)
  } catch {
    // Diagnostics never affect dispatch.
  }
}

/** The host-owned guidance rendered while plan mode is active. */
const POLICY = `PLAN MODE — 计划模式 (host-enforced read-only).

The session's access mode is 计划模式. The sandbox denies every file write and every shell write, and approval escalation is disabled, so a denied mutation cannot be approved. Do not retry a denied mutation.

Explore with read-only operations, resolve discoverable facts by inspection, and when the plan is decision-complete call exit_plan_mode with the complete Markdown plan, starting with a # heading, as the only and final tool call of that response. Approval restores the previous access mode and starts implementation. A conversational "yes" or an imperative request to implement is not approval.`

/** Per-session incremental fold over plan/permission session events. */
const folds = new WeakMap()

/** Per-session pending reconcile timer. */
const timers = new WeakMap()

function eventsOf(session) {
  try {
    if (Array.isArray(session?.events)) return session.events
    if (typeof session?.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    }
  } catch {
    // A session without a readable log has no plan state.
  }
  return []
}

/**
 * Fold the committed log. `lastPlanSeq` / `lastPermSeq` order the two intents:
 * after a `/plan` the plan event is newest; after selecting a preset the
 * permission event is newest. The last non-plan preset is the restore target.
 */
function fold(session) {
  const events = eventsOf(session)
  let state = folds.get(session)
  if (state === undefined) {
    state = {
      next: 0,
      planActive: false,
      lastPlanSeq: -1,
      lastPermSeq: -1,
      lastPreset: undefined,
      lastNonPlan: undefined,
    }
    folds.set(session, state)
  }
  if (events.length < state.next) {
    state.next = 0
    state.planActive = false
    state.lastPlanSeq = -1
    state.lastPermSeq = -1
    state.lastPreset = undefined
    state.lastNonPlan = undefined
  }
  for (; state.next < events.length; state.next += 1) {
    const event = events[state.next]
    if (event === null || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : state.next
    if (event.type === 'plan/mode' && typeof event.data?.active === 'boolean') {
      state.planActive = event.data.active
      state.lastPlanSeq = seq
    } else if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') {
      state.lastPreset = event.data.preset
      state.lastPermSeq = seq
      if (event.data.preset !== PLAN_PRESET) state.lastNonPlan = event.data.preset
    }
  }
  return state
}

function agentOf(ctx, session) {
  try {
    const registry = ctx.agents
    const direct = registry?.get?.(session.id)
    if (direct?.session === session) return direct
    for (const agent of registry?.list?.() ?? []) {
      if (agent?.session === session) return agent
    }
  } catch {
    // No registry entry means the agent is already gone.
  }
  return undefined
}

function currentPreset(ctx, session) {
  try {
    return ctx.permissionPresets.current(session)
  } catch {
    return undefined
  }
}

function warn(ctx, text) {
  mark(`warn ${text}`)
  try {
    ctx.logger?.warn?.(`dsh-plan-access-mode: ${text}`)
  } catch {
    // Logging is best-effort.
  }
}

function hasPlanCommand(ctx, agent) {
  try {
    return ctx.commands.find(agent, 'plan') !== undefined
  } catch {
    return false
  }
}

function runCommand(ctx, agent, line, label) {
  const controller = new AbortController()
  try {
    void ctx.commands.execute(agent, line, [], controller.signal)
      .then((execution) => {
        mark(`${label} -> ${execution?.result?.kind ?? 'undefined'}`)
      })
      .catch((error) => {
        warn(ctx, `${label} failed: ${String(error)}`)
      })
  } catch (error) {
    warn(ctx, `${label} threw: ${String(error)}`)
  }
}

/** Restore the last non-plan preset, falling back to a configured full access. */
function restorePreset(ctx, session, state) {
  let target = state.lastNonPlan
  if (target === undefined || target === PLAN_PRESET || target === 'custom') {
    try {
      target = ctx.permissionPresets.defaultPreset
    } catch {
      target = undefined
    }
  }
  if (target === undefined || target === PLAN_PRESET || target === 'custom') target = FALLBACK_PRESET
  try {
    ctx.permissionPresets.set(session, target)
    mark(`restore ${target}`)
    return
  } catch (error) {
    warn(ctx, `restore ${target} failed: ${String(error)}`)
  }
  try {
    ctx.permissionPresets.set(session, FALLBACK_PRESET)
    mark(`restore fallback ${FALLBACK_PRESET}`)
  } catch (error) {
    warn(ctx, `fallback restore failed: ${String(error)}`)
  }
}

function enterPlan(ctx, session) {
  const agent = agentOf(ctx, session)
  if (agent === undefined) return
  if (!hasPlanCommand(ctx, agent)) {
    mark('no /plan command in this preset; reverting')
    restorePreset(ctx, session, fold(session))
    return
  }
  mark('enter plan')
  runCommand(ctx, agent, '/plan', '/plan')
}

function leavePlan(ctx, session) {
  const agent = agentOf(ctx, session)
  if (agent === undefined) return
  if (!hasPlanCommand(ctx, agent)) {
    mark('no /plan command in this preset')
    return
  }
  mark('leave plan')
  runCommand(ctx, agent, '/plan off', '/plan off')
}

/**
 * Reconcile one session from its committed log:
 * - planning and the preset was not plan → adopt the plan preset;
 * - planning and the user just picked another preset → leave plan;
 * - not planning but the plan preset is current → enter plan (newest intent
 *   was the preset) or restore the previous preset (newest intent was exit).
 */
function reconcile(ctx, session) {
  const state = fold(session)
  const current = currentPreset(ctx, session)
  if (current === undefined) return

  if (state.planActive) {
    if (current === PLAN_PRESET) return
    const switchedAway = state.lastPermSeq > state.lastPlanSeq
      && state.lastPreset !== undefined
      && state.lastPreset !== PLAN_PRESET
    if (switchedAway) {
      leavePlan(ctx, session)
      return
    }
    try {
      ctx.permissionPresets.set(session, PLAN_PRESET)
      mark(`adopt ${PLAN_PRESET}`)
    } catch (error) {
      warn(ctx, `adopt ${PLAN_PRESET} failed: ${String(error)}`)
    }
    return
  }

  if (current !== PLAN_PRESET) return
  const chosenAfterPlan = state.lastPermSeq > state.lastPlanSeq
  if (chosenAfterPlan) enterPlan(ctx, session)
  else restorePreset(ctx, session, state)
}

/** Defer one reconcile out of the append publication boundary. */
function schedule(ctx, session) {
  if (session === undefined || session === null) return
  if (timers.has(session)) return
  const timer = setTimeout(() => {
    timers.delete(session)
    try {
      reconcile(ctx, session)
    } catch (error) {
      warn(ctx, `reconcile failed: ${String(error)}`)
    }
  }, 0)
  timer.unref?.()
  timers.set(session, timer)
}

export function apply(ctx, config = {}) {
  if (config?.enabled === false) {
    mark('apply disabled')
    return
  }
  mark('apply enabled')

  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type === 'permission/preset' || event?.type === 'plan/mode') schedule(ctx, session)
    }, { prepend: true })
  } catch (error) {
    warn(ctx, `session/event listener failed: ${String(error)}`)
  }

  try {
    ctx.on('agent/created', ({ agent }) => {
      if (agent?.session) schedule(ctx, agent.session)
    })
  } catch (error) {
    warn(ctx, `agent/created listener failed: ${String(error)}`)
  }

  // Align sessions restored by an app restart.
  try {
    for (const agent of ctx.agents.list()) {
      if (agent?.session) schedule(ctx, agent.session)
    }
  } catch (error) {
    warn(ctx, `initial alignment failed: ${String(error)}`)
  }

  // Host-owned guidance; the preset's own plan:policy may be softened.
  try {
    ctx.systemPrompt.section({
      name: 'plan:menu-policy',
      order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
      text: (context) => {
        try {
          const session = context?.agent?.session
          return session !== undefined && fold(session).planActive ? POLICY : ''
        } catch {
          return ''
        }
      },
    })
  } catch (error) {
    warn(ctx, `prompt section failed: ${String(error)}`)
  }

  // Restore before the next request on the step where plan mode closes, so a
  // freshly approved plan starts implementing under the restored access mode.
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        const session = payload?.agent?.session
        if (session !== undefined) {
          const state = fold(session)
          const current = currentPreset(ctx, session)
          if (!state.planActive && current === PLAN_PRESET && state.lastPermSeq <= state.lastPlanSeq) {
            restorePreset(ctx, session, state)
          }
        }
      } catch {
        // A transition failure leaves the manual /plan off escape available.
      }
      return decision
    }, { prepend: true })
  } catch (error) {
    warn(ctx, `agent/pre-step listener failed: ${String(error)}`)
  }
}
