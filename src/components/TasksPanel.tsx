import { useMemo, useState } from 'react';
import type { Domain, Project, Task, TaskContext } from '../types';
import { CONTEXTS, CONTEXT_LABEL } from '../types';
import { indexTasks, isBlocked, isDeferred } from '../availability';
import { todayISO } from '../dates';
import { Button, Card, SectionTitle, Select, TextInput } from '../ui';
import { formatMinutes } from '../styles';
import { TaskRow } from './TaskRow';

/**
 * "Ready" is the filter that makes the availability fields pay off: everything
 * open, minus what you are waiting on and what you promised not to start yet.
 */
type StatusFilter = 'todo' | 'ready' | 'blocked' | 'done' | 'all';
type ContextFilter = TaskContext | 'all' | 'none';
type SortKey = 'priority' | 'due' | 'duration' | 'created';

function sortTasks(tasks: Task[], key: SortKey): Task[] {
  const copy = [...tasks];
  switch (key) {
    case 'priority':
      return copy.sort((a, b) => a.priority - b.priority || a.estimateMin - b.estimateMin);
    case 'due':
      // Undated tasks sort last rather than being treated as due at epoch.
      return copy.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
    case 'duration':
      return copy.sort((a, b) => a.estimateMin - b.estimateMin);
    default:
      return copy.sort((a, b) => b.createdAt - a.createdAt);
  }
}

export type ProjectFilter = number | 'all' | 'none';

export function TasksPanel({
  tasks,
  projects,
  projectId,
  onProjectIdChange,
  onToggle,
  onEdit,
  onDelete,
  onStart,
  onNew,
}: {
  tasks: Task[];
  projects: Project[];
  /** Controlled by the app so the Projects tab can deep-link into this list. */
  projectId: ProjectFilter;
  onProjectIdChange: (value: ProjectFilter) => void;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onStart: (task: Task) => void;
  onNew: () => void;
}) {
  const [domain, setDomain] = useState<Domain | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('todo');
  const [context, setContext] = useState<ContextFilter>('all');
  const [sort, setSort] = useState<SortKey>('priority');
  const [query, setQuery] = useState('');

  const byId = useMemo(() => indexTasks(tasks), [tasks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = todayISO();
    const matchesStatus = (t: Task) => {
      switch (status) {
        case 'all':
          return true;
        case 'done':
          return t.status === 'done';
        case 'blocked':
          return t.status === 'todo' && isBlocked(t, byId);
        case 'ready':
          return t.status === 'todo' && !isBlocked(t, byId) && !isDeferred(t, today);
        default:
          return t.status === 'todo';
      }
    };
    const result = tasks.filter((t) => {
      if (domain !== 'all' && t.domain !== domain) return false;
      if (projectId === 'none' && t.projectId !== undefined) return false;
      if (typeof projectId === 'number' && t.projectId !== projectId) return false;
      if (!matchesStatus(t)) return false;
      if (context === 'none' && t.context !== undefined) return false;
      if (context !== 'all' && context !== 'none' && t.context !== context) return false;
      if (
        q &&
        !t.title.toLowerCase().includes(q) &&
        !t.notes.toLowerCase().includes(q) &&
        !t.tags.some((tag) => tag.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
    return sortTasks(result, sort);
  }, [tasks, byId, domain, projectId, status, context, sort, query]);

  const totalMin = filtered
    .filter((t) => t.status === 'todo')
    .reduce((sum, t) => sum + t.estimateMin, 0);

  // The selected project must always be listed, even when archived or outside
  // the current area filter — otherwise a deep link from the Projects tab shows
  // a blank dropdown.
  const visibleProjects = projects.filter(
    (p) =>
      p.id === projectId ||
      (!p.archived && (domain === 'all' || p.domain === domain)),
  );

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          hint={`${filtered.length} shown · ${formatMinutes(totalMin)} of open work`}
        >
          All tasks
        </SectionTitle>
        <Button variant="primary" onClick={onNew}>
          + New task
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, notes, tags…"
          className="min-w-[200px] flex-1"
        />
        <Select
          value={domain}
          onChange={(e) => {
            setDomain(e.target.value as Domain | 'all');
            onProjectIdChange('all');
          }}
        >
          <option value="all">All areas</option>
          <option value="work">Work</option>
          <option value="personal">Personal</option>
        </Select>
        <Select
          value={projectId}
          onChange={(e) => {
            const v = e.target.value;
            onProjectIdChange(v === 'all' || v === 'none' ? v : Number(v));
          }}
        >
          <option value="all">All projects</option>
          <option value="none">No project</option>
          {visibleProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          <option value="todo">Open</option>
          <option value="ready">Ready now</option>
          <option value="blocked">Blocked</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </Select>
        <Select
          value={context}
          onChange={(e) => setContext(e.target.value as ContextFilter)}
        >
          <option value="all">Any context</option>
          <option value="none">No context</option>
          {CONTEXTS.map((c) => (
            <option key={c} value={c}>
              {CONTEXT_LABEL[c]}
            </option>
          ))}
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="priority">Sort: priority</option>
          <option value="due">Sort: due date</option>
          <option value="duration">Sort: duration</option>
          <option value="created">Sort: newest</option>
        </Select>
      </div>

      <div className="mt-4 -mx-2 divide-y divide-line-soft">
        {filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-mist-500">No tasks match these filters.</p>
        ) : (
          filtered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              project={projects.find((p) => p.id === task.projectId)}
              byId={byId}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
              onStart={onStart}
            />
          ))
        )}
      </div>
    </Card>
  );
}
