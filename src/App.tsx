import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, newUid, nextColor, seedIfEmpty } from './db';
import { recordGrave } from './backup/store';
import type { ChecklistItem, Domain, Project, Situation, Task } from './types';
import { recommend } from './recommender';
import {
  extendSession,
  loadSession,
  pauseSession,
  resumeSession,
  saveSession,
  sessionIsStale,
  spentMinutes,
  startSession,
  type FocusSession,
} from './session';
import { Button } from './ui';
import { formatMinutes } from './styles';
import { FocusPanel } from './components/FocusPanel';
import { FocusSessionView } from './components/FocusSession';
import { ChatPanel } from './components/ChatPanel';
import type { ChatTransport } from './chat/client';
import type { VoiceEngine } from './voice';
import { TasksPanel, type ProjectFilter } from './components/TasksPanel';
import { ProjectsPanel } from './components/ProjectsPanel';
import { DataControls } from './components/DataControls';
import { SyncPanel } from './components/SyncPanel';
import { TaskForm, type TaskDraft } from './components/TaskForm';
import { recordTombstone } from './sync/engine';
import { useSync } from './sync/useSync';
import { useBackup } from './backup/useBackup';

type Tab = 'focus' | 'chat' | 'tasks' | 'projects' | 'sync';

const CONTEXT_KEY = 'pp.context.v1';

const DEFAULT_CONTEXT: Situation = {
  availableMin: 45,
  focus: 'medium',
  domain: 'work',
  projectId: 'all',
  context: 'any',
};

function loadContext(): Situation {
  try {
    const raw = localStorage.getItem(CONTEXT_KEY);
    return raw
      ? { ...DEFAULT_CONTEXT, ...(JSON.parse(raw) as Partial<Situation>) }
      : DEFAULT_CONTEXT;
  } catch {
    return DEFAULT_CONTEXT;
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('focus');
  const [ctx, setCtx] = useState<Situation>(loadContext);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Task | undefined>();
  const [preset, setPreset] = useState<Partial<TaskDraft> | undefined>();
  const [taskProject, setTaskProject] = useState<ProjectFilter>('all');
  const [session, setSession] = useState<FocusSession | null>(loadSession);
  const sync = useSync();
  const backup = useBackup();

  useEffect(() => {
    void seedIfEmpty();
  }, []);

  useEffect(() => {
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(ctx));
  }, [ctx]);

  useEffect(() => {
    saveSession(session);
  }, [session]);

  const tasks = useLiveQuery(() => db.tasks.toArray(), [], undefined as Task[] | undefined);
  const projects = useLiveQuery(() => db.projects.toArray(), [], undefined as Project[] | undefined);

  const loading = tasks === undefined || projects === undefined;
  const allTasks = useMemo(() => tasks ?? [], [tasks]);
  const allProjects = useMemo(() => projects ?? [], [projects]);

  const openTasks = allTasks.filter((t) => t.status === 'todo');
  const doneToday = allTasks.filter(
    (t) =>
      t.status === 'done' &&
      t.completedAt &&
      new Date(t.completedAt).toDateString() === new Date().toDateString(),
  ).length;
  const openMin = openTasks.reduce((s, t) => s + t.estimateMin, 0);
  const topPick = recommend(allTasks, ctx)[0];

  const sessionTask = session ? allTasks.find((t) => t.id === session.taskId) : undefined;

  // A task completed in another tab, deleted, or pulled as done by a sync must
  // not leave a clock running against something that is no longer there.
  useEffect(() => {
    if (loading || !session) return;
    if (sessionIsStale(sessionTask)) setSession(null);
  }, [loading, session, sessionTask]);

  /**
   * The shortest thing worth doing instead, offered by the "I'm stuck" menu.
   * It comes off the same ranking as everything else, so a swap is still a
   * recommendation rather than an arbitrary jump down the list.
   */
  const smallerThanSession = useMemo(() => {
    if (!sessionTask) return undefined;
    return recommend(allTasks, ctx).find(
      (s) => s.task.id !== sessionTask.id && s.task.estimateMin < sessionTask.estimateMin,
    )?.task;
  }, [allTasks, ctx, sessionTask]);

  /**
   * Writes that only touch local-only fields deliberately leave `updatedAt`
   * alone. Bumping it would mark the task as having unsent edits, and the sync
   * engine would then wake up, compare every synced field, find them identical
   * and do nothing — churn in exchange for nothing.
   */
  const bankSessionTime = async (s: FocusSession, task: Task) => {
    const minutes = spentMinutes(s, Date.now());
    if (minutes <= 0 || task.id === undefined) return;
    await db.tasks.put({ ...task, spentMin: (task.spentMin ?? 0) + minutes });
  };

  const beginSession = (task: Task) => {
    if (task.id === undefined) return;
    setSession(startSession(task.id, task.estimateMin, Date.now()));
  };

  const endSession = async () => {
    if (session && sessionTask) await bankSessionTime(session, sessionTask);
    setSession(null);
  };

  const togglePause = () => {
    setSession((s) => (s ? (s.paused ? resumeSession(s, Date.now()) : pauseSession(s, Date.now())) : s));
  };

  /**
   * Running over isn't just a longer clock: the estimate was wrong, and leaving
   * it wrong means every future plan built on it is wrong the same way.
   */
  const extendCurrentSession = async () => {
    if (!session || !sessionTask) return;
    const next = extendSession(session);
    setSession(next);
    if (next.plannedMin > sessionTask.estimateMin) {
      await db.tasks.put({
        ...sessionTask,
        estimateMin: next.plannedMin,
        updatedAt: Date.now(),
      });
    }
  };

  const completeSession = async () => {
    if (!session || !sessionTask) return;
    await bankSessionTime(session, sessionTask);
    const fresh = (await db.tasks.get(session.taskId)) ?? sessionTask;
    await db.tasks.put({
      ...fresh,
      status: 'done',
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });
    setSession(null);
  };

  const parkSession = async (note: string) => {
    if (!session || !sessionTask || !note.trim()) return;
    await bankSessionTime(session, sessionTask);
    const fresh = (await db.tasks.get(session.taskId)) ?? sessionTask;
    await db.tasks.put({ ...fresh, blockedNote: note.trim(), updatedAt: Date.now() });
    setSession(null);
  };

  const swapSession = async (next: Task) => {
    if (session && sessionTask) await bankSessionTime(session, sessionTask);
    beginSession(next);
  };

  const saveChecklist = async (items: ChecklistItem[]) => {
    if (!sessionTask || sessionTask.id === undefined) return;
    await db.tasks.put({ ...sessionTask, checklist: items });
  };

  const openNew = () => {
    setEditing(undefined);
    setPreset(undefined);
    setFormOpen(true);
  };

  /** New task pre-assigned to a project, from the Projects tab. */
  const openNewInProject = (project: Project) => {
    setEditing(undefined);
    setPreset({ projectId: project.id, domain: project.domain });
    setFormOpen(true);
  };

  const viewProjectTasks = (project: Project) => {
    setTaskProject(project.id!);
    setTab('tasks');
  };

  const openEdit = (task: Task) => {
    setEditing(task);
    setPreset(undefined);
    setFormOpen(true);
  };

  const saveTask = async (draft: TaskDraft) => {
    // An empty "waiting on" box means not blocked, so it must not be stored as
    // a blank string: `isBlocked` and the sync footer both key off presence.
    const fields = { ...draft, blockedNote: draft.blockedNote.trim() || undefined };
    if (editing?.id) {
      await db.tasks.put({ ...editing, ...fields, updatedAt: Date.now() });
    } else {
      await db.tasks.add({
        ...fields,
        uid: newUid(),
        status: 'todo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Task);
    }
    setFormOpen(false);
    setEditing(undefined);
  };

  const toggleTask = async (task: Task) => {
    if (!task.id) return;
    const done = task.status === 'done';
    await db.tasks.put({
      ...task,
      status: done ? 'todo' : 'done',
      completedAt: done ? undefined : Date.now(),
      updatedAt: Date.now(),
    });
  };

  const deleteTask = async (task: Task) => {
    if (!task.id || !window.confirm(`Delete "${task.title}"?`)) return;
    // Record the tombstones first, otherwise the server copies would survive
    // and the next pull would re-create the task locally. The grave does the
    // same job for the JSON backup, which has no other way to tell a deletion
    // apart from a record the file has simply not seen yet.
    await recordTombstone('task', task.id);
    await recordGrave('task', task.uid);
    const id = task.id;
    await db.transaction('rw', db.tasks, async () => {
      // Anything waiting on this task is now waiting on nothing. Leaving the
      // reference behind would hide those tasks from every recommendation with
      // no way for the user to see why.
      await db.tasks
        .where('blockedBy')
        .equals(id)
        .modify((dependent) => {
          delete dependent.blockedBy;
          dependent.updatedAt = Date.now();
        });
      await db.tasks.delete(id);
    });
  };

  const createProject = async (name: string, domain: Domain, color: string) => {
    await db.projects.add({
      uid: newUid(),
      name,
      domain,
      color: color || nextColor(allProjects.length),
      archived: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };

  const updateProject = async (project: Project) => {
    if (project.id) await db.projects.put({ ...project, updatedAt: Date.now() });
  };

  /**
   * Editing a project's area takes its tasks with it. Leaving them behind would
   * put the project on one side of the board and its contents on the other:
   * invisible in the mode you'd look for them in, and split across two services.
   */
  const editProject = async (
    project: Project,
    patch: { name: string; domain: Domain; color: string },
  ) => {
    const id = project.id;
    if (id === undefined) return;
    const now = Date.now();
    await db.transaction('rw', db.projects, db.tasks, async () => {
      await db.projects.update(id, { ...patch, updatedAt: now });
      if (patch.domain === project.domain) return;
      const mine = await db.tasks.where('projectId').equals(id).toArray();
      for (const task of mine) {
        if (task.id === undefined || task.domain === patch.domain) continue;
        await db.tasks.update(task.id, { domain: patch.domain, updatedAt: now });
      }
    });
  };

  // Tasks outlive their project: detach them rather than silently deleting work.
  const deleteProject = async (project: Project) => {
    if (!project.id) return;
    const count = allTasks.filter((t) => t.projectId === project.id).length;
    const message = count
      ? `Delete "${project.name}"? Its ${count} task(s) will be kept but moved to "No project".`
      : `Delete "${project.name}"?`;
    if (!window.confirm(message)) return;
    await recordTombstone('project', project.id);
    await recordGrave('project', project.uid);
    await db.transaction('rw', db.tasks, db.projects, async () => {
      // Deleting the key (not setting undefined) keeps the projectId index clean.
      // Orphaned tasks move to the inbox list on the next sync, so they need a
      // fresh updatedAt to be seen as changed.
      await db.tasks
        .where('projectId')
        .equals(project.id!)
        .modify((task) => {
          delete task.projectId;
          task.updatedAt = Date.now();
        });
      await db.projects.delete(project.id!);
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'focus', label: 'Focus' },
    { id: 'chat', label: 'jAIme' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'projects', label: 'Projects' },
    { id: 'sync', label: 'Sync' },
  ];

  // A focus session replaces the whole application, not just the main panel.
  // The point of the screen is that the backlog, the counts and the tabs are
  // all gone: anything still on screen is another thing to think about.
  if (session && sessionTask) {
    return (
      <div className="mx-auto min-h-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <FocusSessionView
          session={session}
          task={sessionTask}
          project={allProjects.find((p) => p.id === sessionTask.projectId)}
          smaller={smallerThanSession}
          onPauseToggle={togglePause}
          onExtend={extendCurrentSession}
          onComplete={completeSession}
          onExit={endSession}
          onBlocked={parkSession}
          onSwap={swapSession}
          onChecklistChange={saveChecklist}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <div className="flex items-center gap-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent-400 to-fuchsia-500 text-base font-bold text-white shadow-lg shadow-accent-500/25">
            N
          </span>
          <div>
            <h1 className="text-[1.375rem] font-semibold leading-none tracking-tight text-fg">
              Nextwise
            </h1>
            {topPick && (
              <p className="mt-1.5 truncate text-[0.8125rem] text-mist-400">
                Next up: <span className="text-mist-200">{topPick.task.title}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {sync.syncing && (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-mist-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
              Syncing…
            </span>
          )}
          <DataControls tasks={allTasks} projects={allProjects} />
          <Button variant="primary" onClick={openNew}>
            + New task
          </Button>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <nav className="no-scrollbar -mx-1 flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-line bg-ink-800/60 p-1 sm:mx-0 sm:inline-flex">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 sm:px-4 sm:py-1.5 ${
                tab === t.id
                  ? 'bg-raise-3 text-fg shadow-sm'
                  : 'text-mist-400 hover:bg-raise-2 hover:text-mist-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-5 px-1">
          {[
            { label: 'Open', value: String(openTasks.length) },
            { label: 'Remaining', value: formatMinutes(openMin) },
            { label: 'Done today', value: String(doneToday) },
          ].map((stat) => (
            <div key={stat.label}>
              <div className="tnum text-base font-semibold leading-tight text-fg">
                {stat.value}
              </div>
              <div className="mt-0.5 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-mist-500">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="py-16 text-center text-sm text-mist-400">Loading your board…</p>
      ) : (
        <main>
          {tab === 'focus' && (
            <FocusPanel
              tasks={allTasks}
              projects={allProjects}
              ctx={ctx}
              onCtxChange={setCtx}
              onToggle={toggleTask}
              onEdit={openEdit}
              onDelete={deleteTask}
              onStart={beginSession}
            />
          )}
          {tab === 'chat' && (
            <ChatPanel
              context={ctx}
              setContext={(patch) => setCtx((prev) => ({ ...prev, ...patch }))}
              transport={
                import.meta.env.DEV
                  ? (globalThis as Record<string, unknown>).__fbChatTransport as
                      | ChatTransport
                      | undefined
                  : undefined
              }
              voice={
                import.meta.env.DEV
                  ? ((globalThis as Record<string, unknown>).__fbVoiceEngine as
                      | VoiceEngine
                      | undefined)
                  : undefined
              }
            />
          )}
          {tab === 'tasks' && (
            <TasksPanel
              tasks={allTasks}
              projects={allProjects}
              projectId={taskProject}
              onProjectIdChange={setTaskProject}
              onToggle={toggleTask}
              onEdit={openEdit}
              onDelete={deleteTask}
              onStart={beginSession}
              onNew={openNew}
            />
          )}
          {tab === 'projects' && (
            <ProjectsPanel
              projects={allProjects}
              tasks={allTasks}
              onCreate={createProject}
              onUpdate={updateProject}
              onEdit={editProject}
              onDelete={deleteProject}
              onToggleTask={toggleTask}
              onEditTask={openEdit}
              onDeleteTask={deleteTask}
              onStartTask={beginSession}
              onAddTask={openNewInProject}
              onViewInTasks={viewProjectTasks}
            />
          )}
          {tab === 'sync' && <SyncPanel sync={sync} backup={backup} />}
        </main>
      )}

      <TaskForm
        open={formOpen}
        initial={editing}
        preset={preset}
        projects={allProjects}
        tasks={allTasks}
        onCancel={() => {
          setFormOpen(false);
          setEditing(undefined);
        }}
        onSave={saveTask}
      />

      <footer className="mt-10 text-center text-xs text-mist-500">
        {backup.configured && backup.hasToken
          ? `Kept in this browser and saved to ${backup.repo.owner}/${backup.repo.repo}.`
          : 'All data stays in this browser (IndexedDB). Set up the GitHub backup on the Sync tab, or export regularly.'}
      </footer>
    </div>
  );
}
