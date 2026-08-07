import { useEffect, useMemo, useState } from 'react';
import type { Domain, FocusLevel, Priority, Project, Task, TaskContext } from '../types';
import { CONTEXTS, CONTEXT_LABEL, FOCUS_LABEL, PRIORITY_LABEL } from '../types';
import { blockerCandidates } from '../availability';
import { Button, Field, Select, TextArea, TextInput } from '../ui';
import { DatePicker } from './DatePicker';

export interface TaskDraft {
  title: string;
  notes: string;
  domain: Domain;
  projectId?: number;
  priority: Priority;
  estimateMin: number;
  focusLevel: FocusLevel;
  dueDate?: string;
  startDate?: string;
  context?: TaskContext;
  blockedBy?: number;
  blockedNote: string;
  tags: string[];
}

const EMPTY: TaskDraft = {
  title: '',
  notes: '',
  domain: 'work',
  projectId: undefined,
  priority: 3,
  estimateMin: 30,
  focusLevel: 'medium',
  dueDate: undefined,
  startDate: undefined,
  context: undefined,
  blockedBy: undefined,
  blockedNote: '',
  tags: [],
};

const ESTIMATE_PRESETS = [10, 15, 30, 45, 60, 90, 120];

export function TaskForm({
  open,
  initial,
  preset,
  projects,
  tasks,
  onCancel,
  onSave,
}: {
  open: boolean;
  initial?: Task;
  /** Pre-filled values for a new task, e.g. when adding from within a project. */
  preset?: Partial<TaskDraft>;
  projects: Project[];
  /** The whole board, so a task can be marked as blocked by another one. */
  tasks: Task[];
  onCancel: () => void;
  onSave: (draft: TaskDraft) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(EMPTY);
  const [tagText, setTagText] = useState('');

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setDraft({
        title: initial.title,
        notes: initial.notes,
        domain: initial.domain,
        projectId: initial.projectId,
        priority: initial.priority,
        estimateMin: initial.estimateMin,
        focusLevel: initial.focusLevel,
        dueDate: initial.dueDate,
        startDate: initial.startDate,
        context: initial.context,
        blockedBy: initial.blockedBy,
        blockedNote: initial.blockedNote ?? '',
        tags: initial.tags,
      });
      setTagText(initial.tags.join(', '));
    } else {
      setDraft({ ...EMPTY, ...preset });
      setTagText(preset?.tags?.join(', ') ?? '');
    }
  }, [open, initial, preset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  // Above the early return, since hooks cannot be called conditionally. A task
  // can never be offered itself, or anything that already depends on it, as its
  // own blocker.
  const candidates = useMemo(
    () => blockerCandidates(initial, tasks).filter((t) => t.id !== initial?.id),
    [initial, tasks],
  );

  if (!open) return null;

  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // A project belongs to one domain, so switching domain must drop a now-invalid project.
  const changeDomain = (domain: Domain) =>
    setDraft((d) => ({
      ...d,
      domain,
      projectId:
        d.projectId && projects.find((p) => p.id === d.projectId)?.domain === domain
          ? d.projectId
          : undefined,
    }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    onSave({
      ...draft,
      title,
      notes: draft.notes.trim(),
      blockedNote: draft.blockedNote.trim(),
      estimateMin: Math.max(5, Math.round(draft.estimateMin)),
      tags: tagText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
  };

  const domainProjects = projects.filter((p) => p.domain === draft.domain && !p.archived);
  const startsAfterDue =
    !!draft.startDate && !!draft.dueDate && draft.startDate > draft.dueDate;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-xl rounded-2xl border border-line bg-ink-800 p-5 shadow-2xl"
      >
        <h2 className="mb-4 text-lg font-semibold text-fg">
          {initial ? 'Edit task' : 'New task'}
        </h2>

        <div className="grid gap-4">
          <Field label="Title">
            <TextInput
              autoFocus
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="What needs doing?"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Area">
              <Select
                value={draft.domain}
                onChange={(e) => changeDomain(e.target.value as Domain)}
              >
                <option value="work">Work</option>
                <option value="personal">Personal</option>
              </Select>
            </Field>

            <Field label="Project">
              <Select
                value={draft.projectId ?? ''}
                onChange={(e) =>
                  set('projectId', e.target.value ? Number(e.target.value) : undefined)
                }
              >
                <option value="">No project</option>
                {domainProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Priority">
              <Select
                value={draft.priority}
                onChange={(e) => set('priority', Number(e.target.value) as Priority)}
              >
                {([1, 2, 3, 4] as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Focus needed">
              <Select
                value={draft.focusLevel}
                onChange={(e) => set('focusLevel', e.target.value as FocusLevel)}
              >
                {(['deep', 'medium', 'shallow'] as FocusLevel[]).map((f) => (
                  <option key={f} value={f}>
                    {FOCUS_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={`Estimated duration — ${draft.estimateMin} min`}>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                type="number"
                min={5}
                step={5}
                value={draft.estimateMin}
                onChange={(e) => set('estimateMin', Number(e.target.value))}
                className="w-24"
              />
              {ESTIMATE_PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => set('estimateMin', m)}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                    draft.estimateMin === m
                      ? 'border-accent-400/60 bg-accent-500/20 font-medium text-fg'
                      : 'border-line text-mist-400 hover:bg-raise-1'
                  }`}
                >
                  {m}m
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Due date (optional)">
              <DatePicker
                value={draft.dueDate}
                onChange={(iso) => set('dueDate', iso)}
              />
            </Field>
            <Field label="Tags (comma separated)">
              <TextInput
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                placeholder="writing, admin"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Context — what you need to hand">
              <Select
                value={draft.context ?? ''}
                onChange={(e) =>
                  set('context', (e.target.value || undefined) as TaskContext | undefined)
                }
              >
                <option value="">Anywhere — no requirement</option>
                {CONTEXTS.map((c) => (
                  <option key={c} value={c}>
                    {CONTEXT_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Not before (optional)">
              <DatePicker
                value={draft.startDate}
                onChange={(iso) => set('startDate', iso)}
                placeholder="Can start any time"
                label="Choose the earliest start date"
              />
            </Field>
          </div>

          {startsAfterDue && (
            <p className="-mt-2 text-xs text-warn">
              This cannot start until after it is due. Check the two dates.
            </p>
          )}

          <fieldset className="grid gap-3 rounded-xl border border-line bg-ink-900/40 p-3.5">
            <legend className="px-1 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
              Blocked
            </legend>

            <div className="grid grid-cols-2 gap-4">
              <Field label="By another task">
                <Select
                  value={draft.blockedBy ?? ''}
                  onChange={(e) =>
                    set('blockedBy', e.target.value ? Number(e.target.value) : undefined)
                  }
                >
                  <option value="">Not blocked by a task</option>
                  {candidates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Or waiting on">
                <TextInput
                  value={draft.blockedNote}
                  onChange={(e) => set('blockedNote', e.target.value)}
                  placeholder="Dana's reply, a delivery…"
                />
              </Field>
            </div>

            <p className="text-[11px] leading-relaxed text-mist-500">
              Either one marks this as blocked: it stays on the board but is kept out of
              recommendations until the other task is done, or you clear the note.
            </p>
          </fieldset>

          <Field label="Notes">
            <TextArea
              rows={3}
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="Context, links, next physical action…"
            />
          </Field>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!draft.title.trim()}>
            {initial ? 'Save changes' : 'Add task'}
          </Button>
        </div>
      </form>
    </div>
  );
}
