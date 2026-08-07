import { useMemo, useState } from 'react';
import type { Domain, Project, Task } from '../types';
import { PALETTE } from '../db';
import { indexTasks } from '../availability';
import { Badge, Button, Card, Progress, SectionTitle, Select, TextInput } from '../ui';
import { formatMinutes } from '../styles';
import { TaskRow } from './TaskRow';

interface ProjectStats {
  open: number;
  done: number;
  openMin: number;
}

function statsFor(tasks: Task[], projectId: number): ProjectStats {
  const mine = tasks.filter((t) => t.projectId === projectId);
  const open = mine.filter((t) => t.status === 'todo');
  return {
    open: open.length,
    done: mine.length - open.length,
    openMin: open.reduce((s, t) => s + t.estimateMin, 0),
  };
}

/** Most urgent first, so an expanded project reads like a work queue. */
function byPriorityThenDue(a: Task, b: Task): number {
  return (
    a.priority - b.priority ||
    (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
    a.estimateMin - b.estimateMin
  );
}

export function ProjectsPanel({
  projects,
  tasks,
  onCreate,
  onUpdate,
  onEdit,
  onDelete,
  onToggleTask,
  onEditTask,
  onDeleteTask,
  onStartTask,
  onAddTask,
  onViewInTasks,
}: {
  projects: Project[];
  tasks: Task[];
  onCreate: (name: string, domain: Domain, color: string) => void;
  onUpdate: (project: Project) => void;
  onEdit: (project: Project, patch: { name: string; domain: Domain; color: string }) => void;
  onDelete: (project: Project) => void;
  onToggleTask: (task: Task) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onStartTask: (task: Task) => void;
  onAddTask: (project: Project) => void;
  onViewInTasks: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState<Domain>('work');
  const [color, setColor] = useState(PALETTE[0]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const byId = useMemo(() => indexTasks(tasks), [tasks]);
  const [draft, setDraft] = useState({ name: '', domain: 'work' as Domain, color: PALETTE[0] });

  const startEdit = (project: Project) => {
    setEditingId(project.id!);
    setDraft({ name: project.name, domain: project.domain, color: project.color });
  };

  const saveEdit = (project: Project) => {
    const trimmed = draft.name.trim();
    if (!trimmed) return;
    onEdit(project, { name: trimmed, domain: draft.domain, color: draft.color });
    setEditingId(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, domain, color);
    setName('');
    setColor(PALETTE[(PALETTE.indexOf(color) + 1) % PALETTE.length]);
  };

  const groups: { label: string; domain: Domain }[] = [
    { label: 'Work', domain: 'work' },
    { label: 'Personal', domain: 'personal' },
  ];

  return (
    <div className="grid gap-5">
      <Card className="p-5">
        <SectionTitle hint="Group related tasks">New project</SectionTitle>
        <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-2">
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="min-w-[220px] flex-1"
          />
          <Select value={domain} onChange={(e) => setDomain(e.target.value as Domain)}>
            <option value="work">Work</option>
            <option value="personal">Personal</option>
          </Select>
          <div className="flex items-center gap-1 rounded-lg border border-line bg-ink-900/70 px-2 py-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => setColor(c)}
                className={`h-5 w-5 rounded-full transition-transform ${
                  color === c ? 'scale-110 ring-2 ring-fg/70' : 'opacity-70 hover:opacity-100'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Add project
          </Button>
        </form>
      </Card>

      {groups.map(({ label, domain: d }) => {
        const list = projects.filter((p) => p.domain === d);
        return (
          <Card key={d} className="p-5">
            <SectionTitle hint={`${list.length} project${list.length === 1 ? '' : 's'}`}>
              {label}
            </SectionTitle>
            <div className="mt-2 -mx-2 divide-y divide-line-soft">
              {list.length === 0 && (
                <p className="py-6 text-center text-sm text-mist-500">
                  No {label.toLowerCase()} projects yet.
                </p>
              )}
              {list.map((project) => {
                const s = statsFor(tasks, project.id!);
                const expanded = expandedId === project.id;
                const editing = editingId === project.id;
                const mine = tasks
                  .filter((t) => t.projectId === project.id)
                  .filter((t) => showDone || t.status === 'todo')
                  .sort(byPriorityThenDue);
                return (
                  <div
                    key={project.id}
                    className={`group rounded-xl transition-colors ${
                      expanded ? 'bg-raise-1' : 'hover:bg-raise-1'
                    }`}
                  >
                    {editing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          saveEdit(project);
                        }}
                        className="flex flex-wrap items-center gap-2 px-3 py-2.5"
                      >
                        <TextInput
                          value={draft.name}
                          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                          aria-label="Project name"
                          autoFocus
                          className="min-w-[180px] flex-1"
                        />
                        <Select
                          value={draft.domain}
                          aria-label="Project area"
                          onChange={(e) => setDraft({ ...draft, domain: e.target.value as Domain })}
                        >
                          <option value="work">Work</option>
                          <option value="personal">Personal</option>
                        </Select>
                        <div className="flex items-center gap-1 rounded-lg border border-line bg-ink-900/70 px-2 py-1.5">
                          {PALETTE.map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={`Colour ${c}`}
                              onClick={() => setDraft({ ...draft, color: c })}
                              className={`h-5 w-5 rounded-full transition-transform ${
                                draft.color === c
                                  ? 'scale-110 ring-2 ring-fg/70'
                                  : 'opacity-70 hover:opacity-100'
                              }`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <Button type="submit" variant="primary" disabled={!draft.name.trim()}>
                          Save
                        </Button>
                        <Button type="button" onClick={() => setEditingId(null)}>
                          Cancel
                        </Button>
                        {draft.domain !== project.domain && (
                          <p className="w-full text-xs text-warn">
                            {s.open + s.done === 0
                              ? `Moves to ${draft.domain}.`
                              : `Its ${s.open + s.done} task${
                                  s.open + s.done === 1 ? '' : 's'
                                } move to ${draft.domain} too.`}
                          </p>
                        )}
                      </form>
                    ) : (
                    <div className="flex items-center gap-3 px-3 py-2.5">
                      <button
                        onClick={() => setExpandedId(expanded ? null : project.id!)}
                        aria-expanded={expanded}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <svg
                          viewBox="0 0 12 12"
                          aria-hidden="true"
                          className={`h-3 w-3 shrink-0 fill-mist-400 transition-transform ${
                            expanded ? 'rotate-90' : ''
                          }`}
                        >
                          <path d="M4 2l4 4-4 4z" />
                        </svg>
                        <span
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: project.color }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-sm font-medium ${
                                project.archived ? 'text-mist-400 line-through' : 'text-fg'
                              }`}
                            >
                              {project.name}
                            </span>
                            {project.archived === 1 && (
                              <Badge className="border-line bg-raise-1 text-mist-500">
                                archived
                              </Badge>
                            )}
                          </span>
                          <span className="mt-1 block text-xs text-mist-400">
                            {s.open} open · {s.done} done · {formatMinutes(s.openMin)} remaining
                          </span>
                          <Progress
                            value={s.open + s.done === 0 ? 0 : s.done / (s.open + s.done)}
                            className="mt-2 max-w-[200px]"
                          />
                        </span>
                      </button>
                      <div className="reveal flex shrink-0 gap-1 transition-opacity">
                        <button
                          onClick={() => startEdit(project)}
                          className="rounded-md px-2 py-1 text-xs text-mist-400 hover:bg-raise-3 hover:text-mist-200"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() =>
                            onUpdate({ ...project, archived: project.archived ? 0 : 1 })
                          }
                          className="rounded-md px-2 py-1 text-xs text-mist-400 hover:bg-raise-3 hover:text-mist-200"
                        >
                          {project.archived ? 'Restore' : 'Archive'}
                        </button>
                        <button
                          onClick={() => onDelete(project)}
                          className="rounded-md px-2 py-1 text-xs text-mist-400 hover:bg-rose-500/15 hover:text-danger"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    )}

                    {expanded && (
                      <div className="border-t border-line px-3 py-3">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <label className="flex cursor-pointer items-center gap-2 text-xs text-mist-400">
                            <input
                              type="checkbox"
                              checked={showDone}
                              onChange={(e) => setShowDone(e.target.checked)}
                             
                            />
                            Show completed
                          </label>
                          <div className="flex gap-2">
                            <Button onClick={() => onViewInTasks(project)}>View in Tasks</Button>
                            <Button variant="primary" onClick={() => onAddTask(project)}>
                              + Add task
                            </Button>
                          </div>
                        </div>

                        {mine.length === 0 ? (
                          <p className="py-6 text-center text-sm text-mist-400">
                            {s.done > 0 && !showDone
                              ? 'Nothing open — tick "Show completed" to see finished tasks.'
                              : 'No tasks in this project yet.'}
                          </p>
                        ) : (
                          <div className="grid gap-2">
                            {mine.map((task) => (
                              <TaskRow
                                key={task.id}
                                task={task}
                                byId={byId}
                                onToggle={onToggleTask}
                                onEdit={onEditTask}
                                onDelete={onDeleteTask}
                                onStart={onStartTask}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
