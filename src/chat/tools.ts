import { db, newUid, PALETTE } from '../db';
import { recommend, buildSessionPlan, withheld } from '../recommender';
import { blockedReason, indexTasks, isActionable, wouldCycle } from '../availability';
import { isValidISODate, todayISO } from '../dates';
import type { Domain, FocusLevel, Priority, Situation, Task, TaskContext } from '../types';
import { CONTEXTS } from '../types';
import type { ToolSchema } from './client';

/**
 * The board is small enough to hand to the model wholesale, but doing so on
 * every turn would burn tokens and bury the useful rows. Tools let it ask for
 * exactly the slice it needs, and — more importantly — let it *act*.
 *
 * Deliberately absent: any tool that deletes. Deletion is the one action that
 * cannot be undone from the UI, and a chat interface is the wrong place for an
 * irreversible action triggered by a possibly-misread sentence. Completing a
 * task is offered instead, which is reversible.
 */
export interface ToolDeps {
  getContext(): Situation;
  setContext(patch: Partial<Situation>): void;
}

const DOMAINS: Domain[] = ['work', 'personal'];
const FOCUS: FocusLevel[] = ['deep', 'medium', 'shallow'];

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function asDomain(v: unknown): Domain | undefined {
  return DOMAINS.includes(v as Domain) ? (v as Domain) : undefined;
}
function asFocus(v: unknown): FocusLevel | undefined {
  return FOCUS.includes(v as FocusLevel) ? (v as FocusLevel) : undefined;
}
function asPriority(v: unknown): Priority | undefined {
  const n = num(v);
  return n && n >= 1 && n <= 4 ? (n as Priority) : undefined;
}
function asContext(v: unknown): TaskContext | undefined {
  return CONTEXTS.includes(v as TaskContext) ? (v as TaskContext) : undefined;
}
/** Dates from the model are the one input most likely to be malformed. */
function asDate(v: unknown): string | undefined {
  const s = str(v);
  return s && isValidISODate(s) ? s : undefined;
}

/** Compact shape: the model does not need bookkeeping timestamps. */
function summarise(task: Task, projectName?: string, byId = new Map<number, Task>()) {
  return {
    id: task.id,
    title: task.title,
    area: task.domain,
    project: projectName,
    priority: `P${task.priority}`,
    estimateMin: task.estimateMin,
    focus: task.focusLevel,
    due: task.dueDate,
    notBefore: task.startDate,
    context: task.context,
    blocked: blockedReason(task, byId),
    status: task.status,
    tags: task.tags.length ? task.tags : undefined,
  };
}

/** Shared by create_task and update_task so the two never describe a field differently. */
const AVAILABILITY_PROPS = {
  context: {
    type: 'string',
    enum: CONTEXTS,
    description:
      'Where the user must be, or what they need to hand, to do this at all. Omit when it ' +
      'can be done anywhere.',
  },
  startDate: {
    type: 'string',
    description: 'Earliest sensible start, ISO yyyy-MM-dd. Hides the task until then.',
  },
  blockedBy: {
    type: 'number',
    description:
      'Id of a task that must finish first. Use 0 to clear it. The task is hidden from ' +
      'recommendations until the blocker is done.',
  },
  blockedNote: {
    type: 'string',
    description:
      'What the user is waiting on when it is not a task on the board, e.g. "Dana\'s reply". ' +
      'An empty string clears it.',
  },
} as const;

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'list_tasks',
    description:
      'List tasks on the board. Use this before answering questions about what exists, ' +
      'and to find the id of a task the user described in words.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string', enum: ['work', 'personal'], description: 'Omit for both.' },
        status: { type: 'string', enum: ['todo', 'done'], description: 'Defaults to todo.' },
        projectId: { type: 'number' },
        search: { type: 'string', description: 'Case-insensitive match on title, notes and tags.' },
        context: {
          type: 'string',
          enum: CONTEXTS,
          description: 'Only tasks needing this place or device.',
        },
        onlyReady: {
          type: 'boolean',
          description:
            'Drop anything blocked or not startable yet. Use this when the user asks what ' +
            'they can actually do.',
        },
      },
    },
  },
  {
    name: 'recommend',
    description:
      "Ask the app's own scoring engine what to work on now, and get a session plan that " +
      'packs the available time. Always use this instead of ranking tasks yourself, so your ' +
      "advice matches the Focus tab exactly and carries the app's explanations.",
    input_schema: {
      type: 'object',
      properties: {
        availableMin: { type: 'number', description: "Defaults to the user's current setting." },
        focus: { type: 'string', enum: ['deep', 'medium', 'shallow'] },
        area: { type: 'string', enum: ['work', 'personal', 'both'] },
        where: {
          type: 'string',
          enum: [...CONTEXTS, 'any'],
          description:
            'Where the user is right now. Tasks needing somewhere else are excluded entirely.',
        },
      },
    },
  },
  {
    name: 'create_task',
    description:
      'Add a task. Infer sensible values for estimate, focus and priority from how the user ' +
      'describes it rather than asking about every field.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        area: { type: 'string', enum: ['work', 'personal'] },
        projectId: { type: 'number' },
        priority: { type: 'number', description: '1 critical to 4 low. Defaults to 3.' },
        estimateMin: { type: 'number', description: 'Defaults to 30.' },
        focus: { type: 'string', enum: ['deep', 'medium', 'shallow'] },
        dueDate: { type: 'string', description: 'ISO yyyy-MM-dd.' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        ...AVAILABILITY_PROPS,
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Change fields on an existing task. Only pass the fields that change.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        area: { type: 'string', enum: ['work', 'personal'] },
        projectId: { type: 'number', description: 'Use 0 to remove it from its project.' },
        priority: { type: 'number' },
        estimateMin: { type: 'number' },
        focus: { type: 'string', enum: ['deep', 'medium', 'shallow'] },
        dueDate: { type: 'string' },
        notes: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        ...AVAILABILITY_PROPS,
      },
      required: ['id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done, or reopen it with done=false.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number' }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
  {
    name: 'list_projects',
    description: 'List projects with their area and open-task counts.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_project',
    description: 'Create a project to group tasks.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        area: { type: 'string', enum: ['work', 'personal'] },
      },
      required: ['name', 'area'],
    },
  },
  {
    name: 'set_context',
    description:
      'Update the time available, focus level, area, or where the user is. Do this when they ' +
      'mention their situation, e.g. "I have 20 minutes", "I am fried" or "I am on my phone".',
    input_schema: {
      type: 'object',
      properties: {
        availableMin: { type: 'number' },
        focus: { type: 'string', enum: ['deep', 'medium', 'shallow'] },
        area: { type: 'string', enum: ['work', 'personal', 'both'] },
        where: { type: 'string', enum: [...CONTEXTS, 'any'] },
      },
    },
  },
];

async function projectNames(): Promise<Map<number, string>> {
  const projects = await db.projects.toArray();
  return new Map(projects.flatMap((p) => (p.id === undefined ? [] : [[p.id, p.name] as const])));
}

/**
 * Turns a blocker id from the model into something safe to store.
 *
 * The model is guessing at ids from a list it saw earlier in the conversation,
 * so a stale or invented one is a real possibility and has to fail loudly
 * rather than silently hide a task behind a blocker that does not exist.
 */
async function resolveBlocker(raw: unknown, self?: number): Promise<number | undefined> {
  const id = num(raw);
  if (id === undefined || id === 0) return undefined;
  const blocker = await db.tasks.get(id);
  if (!blocker) throw new Error(`No task with id ${id} to be blocked by.`);
  if (self !== undefined) {
    const byId = indexTasks(await db.tasks.toArray());
    if (wouldCycle(self, id, byId)) {
      throw new Error(`Task ${id} already depends on ${self}, so that would be circular.`);
    }
  }
  return id;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  deps: ToolDeps,
): Promise<unknown> {
  const now = Date.now();

  switch (name) {
    case 'list_tasks': {
      const names = await projectNames();
      const status = str(input.status) ?? 'todo';
      const area = asDomain(input.area);
      const projectId = num(input.projectId);
      const where = asContext(input.context);
      const search = str(input.search)?.toLowerCase();
      // Titles are not indexed in Dexie, so filtering happens in memory.
      const all = await db.tasks.toArray();
      const byId = indexTasks(all);
      const today = todayISO();
      const rows = all
        .filter((t) => t.status === status)
        .filter((t) => !area || t.domain === area)
        .filter((t) => projectId === undefined || t.projectId === projectId)
        .filter((t) => !where || t.context === where)
        .filter((t) => input.onlyReady !== true || isActionable(t, byId, today))
        .filter(
          (t) =>
            !search ||
            t.title.toLowerCase().includes(search) ||
            t.notes.toLowerCase().includes(search) ||
            t.tags.some((tag) => tag.toLowerCase().includes(search)),
        )
        .map((t) => summarise(t, t.projectId ? names.get(t.projectId) : undefined, byId));
      return { count: rows.length, tasks: rows };
    }

    case 'recommend': {
      const base = deps.getContext();
      const where = str(input.where);
      const ctx: Situation = {
        ...base,
        availableMin: num(input.availableMin) ?? base.availableMin,
        focus: asFocus(input.focus) ?? base.focus,
        domain: (str(input.area) as Situation['domain']) ?? base.domain,
        context: where === 'any' ? 'any' : (asContext(where) ?? base.context),
      };
      const names = await projectNames();
      const all = await db.tasks.toArray();
      const byId = indexTasks(all);
      const scored = recommend(all, ctx);
      const plan = buildSessionPlan(scored, ctx.availableMin);
      return {
        context: {
          availableMin: ctx.availableMin,
          focus: ctx.focus,
          area: ctx.domain,
          where: ctx.context ?? 'any',
        },
        top: scored.slice(0, 5).map((s) => ({
          ...summarise(s.task, s.task.projectId ? names.get(s.task.projectId) : undefined, byId),
          score: Math.round(s.score),
          overBudget: s.overBudget || undefined,
          why: s.reasons
            .filter((r) => r.points !== 0)
            .map((r) => `${r.label} ${r.points > 0 ? '+' : ''}${Math.round(r.points)}`),
        })),
        // Saying what was left out, and why, keeps the model from confidently
        // reporting an empty board when the board is merely stuck.
        heldBack: withheld(all, ctx),
        sessionPlan: {
          tasks: plan.items.map((i) => i.task.title),
          usedMin: plan.usedMin,
          leftoverMin: plan.leftoverMin,
        },
      };
    }

    case 'create_task': {
      const title = str(input.title);
      if (!title) throw new Error('A title is required.');
      const projectId = num(input.projectId);
      const project = projectId ? await db.projects.get(projectId) : undefined;
      if (projectId && !project) throw new Error(`No project with id ${projectId}.`);
      const ctx = deps.getContext();
      // A task inherits its project's area, since the two must not diverge.
      const domain =
        project?.domain ??
        asDomain(input.area) ??
        (ctx.domain === 'both' ? 'personal' : ctx.domain);
      const id = await db.tasks.add({
        uid: newUid(),
        title,
        notes: str(input.notes) ?? '',
        domain,
        projectId: project?.id,
        priority: asPriority(input.priority) ?? 3,
        estimateMin: num(input.estimateMin) ?? 30,
        focusLevel: asFocus(input.focus) ?? 'medium',
        dueDate: asDate(input.dueDate),
        startDate: asDate(input.startDate),
        context: asContext(input.context),
        blockedBy: await resolveBlocker(input.blockedBy),
        blockedNote: str(input.blockedNote),
        status: 'todo',
        tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => !!str(t)) : [],
        createdAt: now,
        updatedAt: now,
      });
      const created = await db.tasks.get(id);
      const byId = indexTasks(await db.tasks.toArray());
      return { created: summarise(created!, project?.name, byId) };
    }

    case 'update_task': {
      const id = num(input.id);
      const existing = id ? await db.tasks.get(id) : undefined;
      if (!existing || id === undefined) throw new Error(`No task with id ${String(input.id)}.`);

      const patch: Partial<Task> = { updatedAt: now };
      // Fields the model explicitly emptied. Dexie's update() ignores undefined,
      // so removing a value takes a full put with the key deleted.
      const cleared = new Set<string>();

      const title = str(input.title);
      if (title) patch.title = title;
      if (str(input.notes) !== undefined) patch.notes = str(input.notes)!;
      const area = asDomain(input.area);
      if (area) patch.domain = area;
      const priority = asPriority(input.priority);
      if (priority) patch.priority = priority;
      const estimate = num(input.estimateMin);
      if (estimate) patch.estimateMin = estimate;
      const focus = asFocus(input.focus);
      if (focus) patch.focusLevel = focus;
      const due = asDate(input.dueDate);
      if (due) patch.dueDate = due;
      if (Array.isArray(input.tags)) {
        patch.tags = input.tags.filter((t): t is string => !!str(t));
      }

      const start = asDate(input.startDate);
      if (start) patch.startDate = start;
      else if (input.startDate === '' || input.startDate === null) cleared.add('startDate');

      const where = asContext(input.context);
      if (where) patch.context = where;
      else if (input.context === '' || input.context === null) cleared.add('context');

      if (typeof input.blockedNote === 'string') {
        const note = str(input.blockedNote);
        if (note) patch.blockedNote = note;
        else cleared.add('blockedNote');
      }

      if (input.blockedBy !== undefined && input.blockedBy !== null) {
        const blocker = await resolveBlocker(input.blockedBy, id);
        if (blocker === undefined) cleared.add('blockedBy');
        else patch.blockedBy = blocker;
      }

      const projectId = num(input.projectId);
      if (projectId !== undefined) {
        if (projectId === 0) {
          cleared.add('projectId');
        } else {
          const project = await db.projects.get(projectId);
          if (!project) throw new Error(`No project with id ${projectId}.`);
          patch.projectId = projectId;
          patch.domain = project.domain;
        }
      }

      if (cleared.size > 0) {
        const next: Record<string, unknown> = { ...existing, ...patch, id };
        for (const key of cleared) delete next[key];
        await db.tasks.put(next as unknown as Task);
      } else {
        await db.tasks.update(id, patch);
      }

      const updated = await db.tasks.get(id);
      const names = await projectNames();
      const byId = indexTasks(await db.tasks.toArray());
      return {
        updated: summarise(
          updated!,
          updated!.projectId ? names.get(updated!.projectId) : undefined,
          byId,
        ),
      };
    }

    case 'complete_task': {
      const id = num(input.id);
      const existing = id ? await db.tasks.get(id) : undefined;
      if (!existing || id === undefined) throw new Error(`No task with id ${String(input.id)}.`);
      const done = input.done !== false;
      if (done) {
        await db.tasks.update(id, { status: 'done', completedAt: now, updatedAt: now });
      } else {
        const { completedAt: _drop, ...rest } = existing;
        await db.tasks.put({ ...rest, id, status: 'todo', updatedAt: now });
      }
      const after = await db.tasks.get(id);
      return { updated: summarise(after!) };
    }

    case 'list_projects': {
      const projects = await db.projects.toArray();
      const tasks = await db.tasks.toArray();
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          area: p.domain,
          archived: p.archived === 1 || undefined,
          openTasks: tasks.filter((t) => t.projectId === p.id && t.status === 'todo').length,
        })),
      };
    }

    case 'create_project': {
      const projectName = str(input.name);
      const area = asDomain(input.area);
      if (!projectName) throw new Error('A name is required.');
      if (!area) throw new Error('An area of work or personal is required.');
      const existing = await db.projects.toArray();
      const id = await db.projects.add({
        uid: newUid(),
        name: projectName,
        domain: area,
        color: PALETTE[existing.length % PALETTE.length],
        archived: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { created: { id, name: projectName, area } };
    }

    case 'set_context': {
      const patch: Partial<Situation> = {};
      const availableMin = num(input.availableMin);
      if (availableMin) patch.availableMin = availableMin;
      const focus = asFocus(input.focus);
      if (focus) patch.focus = focus;
      const area = str(input.area) as Situation['domain'] | undefined;
      if (area === 'work' || area === 'personal' || area === 'both') patch.domain = area;
      const where = str(input.where);
      if (where === 'any') patch.context = 'any';
      else if (asContext(where)) patch.context = asContext(where);
      deps.setContext(patch);
      return { context: { ...deps.getContext(), ...patch } };
    }

    default:
      throw new Error(`Unknown tool ${name}.`);
  }
}
