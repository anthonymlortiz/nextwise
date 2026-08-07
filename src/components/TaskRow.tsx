import type { Project, Task } from '../types';
import { CONTEXT_LABEL, CONTEXT_SHORT } from '../types';
import { daysUntil } from '../recommender';
import { blockedReason, isDeferred, type TaskMap } from '../availability';
import { checklistProgress } from '../session';
import { formatDate, relativeLabel } from '../dates';
import { Badge, Dot, Linkified, Meta, MetaDot } from '../ui';
import { FOCUS_DOT, PRIORITY_RAIL, PRIORITY_TEXT, formatMinutes } from '../styles';

const NO_TASKS: TaskMap = new Map();

/**
 * Due dates only take colour when they actually demand attention. Anything more
 * than a day out is just another piece of metadata.
 */
function DueLabel({ dueDate }: { dueDate: string }) {
  const days = daysUntil(dueDate);
  const label =
    days < 0
      ? `${-days}d overdue`
      : days === 0
        ? 'Today'
        : days === 1
          ? 'Tomorrow'
          : `${days}d`;
  const tone =
    days < 0 ? 'text-danger font-medium' : days <= 1 ? 'text-warn font-medium' : '';
  return (
    <span className={tone} title={`Due ${dueDate}`}>
      {label}
    </span>
  );
}

export function TaskRow({
  task,
  project,
  byId = NO_TASKS,
  onToggle,
  onEdit,
  onDelete,
  onStart,
  trailing,
}: {
  task: Task;
  project?: Project;
  /** The board by id, so a blocking task can be named rather than numbered. */
  byId?: TaskMap;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  /** Omitted where a focus session makes no sense, e.g. a completed-task list. */
  onStart?: (task: Task) => void;
  trailing?: React.ReactNode;
}) {
  const done = task.status === 'done';
  const blocked = done ? undefined : blockedReason(task, byId);
  const deferred = !done && isDeferred(task);
  const steps = checklistProgress(task.checklist);
  // A deferred task is a date the user set and may change their mind about, so
  // starting it is a legitimate override. A blocked one is not: the session
  // screen itself ends a session the moment you mark its task blocked, so
  // offering to start one here would contradict that.
  const canStart = Boolean(onStart) && !done && !blocked;

  return (
    <div
      data-task-title={task.title}
      className="group relative flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 pl-4 transition-colors hover:bg-raise-1"
    >
      {/* Priority rail: the row's loudest signal, and free of horizontal space. */}
      <span
        aria-hidden="true"
        data-priority-rail={task.priority}
        data-rail-muted={done || blocked || deferred ? '1' : '0'}
        className={`absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full transition-opacity ${
          done || blocked || deferred ? 'bg-raise-3' : PRIORITY_RAIL[task.priority]
        }`}
      />

      <button
        onClick={() => onToggle(task)}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        className={`tap mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-all duration-150 ${
          done
            ? 'border-emerald-400/40 bg-emerald-500/25 text-good'
            : 'border-line-strong hover:border-accent-400 hover:bg-accent-500/15'
        }`}
      >
        {done && (
          <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current">
            <path d="M4.6 8.4L2.2 6l-.8.8 3.2 3.2 6-6-.8-.8z" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div
          className={`text-[0.9375rem] leading-snug break-words ${
            done ? 'text-mist-500 line-through' : 'font-medium text-fg'
          }`}
        >
          <Linkified text={task.title} />
        </div>

        <Meta className="mt-1">
          <span className={`font-semibold ${PRIORITY_TEXT[task.priority]}`}>P{task.priority}</span>
          <MetaDot />
          <span className="tnum">{formatMinutes(task.estimateMin)}</span>
          <MetaDot />
          <span className="inline-flex items-center gap-1">
            <Dot className={FOCUS_DOT[task.focusLevel]} />
            {task.focusLevel}
          </span>
          <MetaDot />
          <span>{task.domain}</span>
          {task.context && (
            <>
              <MetaDot />
              {/* The GTD "@place" convention, which also keeps it visually
                  distinct from the #tags further along the same line. */}
              <span data-task-context={task.context} title={CONTEXT_LABEL[task.context]}>
                @{CONTEXT_SHORT[task.context]}
              </span>
            </>
          )}
          {project && (
            <>
              <MetaDot />
              <span className="inline-flex items-center gap-1 text-mist-300">
                <Dot style={{ backgroundColor: project.color }} />
                {project.name}
              </span>
            </>
          )}
          {task.dueDate && !done && (
            <>
              <MetaDot />
              <DueLabel dueDate={task.dueDate} />
            </>
          )}
          {deferred && task.startDate && (
            <>
              <MetaDot />
              <span data-task-start={task.startDate} title={`Not before ${formatDate(task.startDate)}`}>
                starts {relativeLabel(task.startDate)}
              </span>
            </>
          )}
          {steps.total > 0 && (
            <>
              <MetaDot />
              {/* Checklists are only editable inside a focus session, so the
                  row has to at least admit that one exists. */}
              <span
                data-task-steps={`${steps.done}/${steps.total}`}
                className="tnum"
                title={`${steps.done} of ${steps.total} steps done`}
              >
                {steps.done}/{steps.total} steps
              </span>
            </>
          )}
          {task.tags.map((tag) => (
            <span key={tag} className="text-mist-500">
              #{tag}
            </span>
          ))}
        </Meta>

        {blocked && (
          <div data-task-blocked="" className="mt-1.5 flex items-center gap-1.5">
            <Badge className="border-line-strong bg-raise-2 text-mist-300">Blocked</Badge>
            <span className="min-w-0 truncate text-xs text-mist-400">{blocked}</span>
          </div>
        )}

        {task.notes && (
          <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-mist-500">
            <Linkified text={task.notes} />
          </p>
        )}

        {trailing}
      </div>

      <div className="reveal flex w-full shrink-0 items-center justify-end gap-0.5 transition-opacity sm:w-auto sm:justify-start">
        {canStart && (
          <button
            data-start-task={task.title}
            onClick={() => onStart?.(task)}
            title={`Focus on this for ${formatMinutes(task.estimateMin)}`}
            className="rounded-md px-2 py-1.5 text-xs font-medium text-mist-300 transition-colors hover:bg-accent-500/15 hover:text-fg sm:py-1"
          >
            Start
          </button>
        )}
        <button
          onClick={() => onEdit(task)}
          className="rounded-md px-2 py-1.5 text-xs text-mist-400 transition-colors hover:bg-raise-3 hover:text-fg sm:py-1"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(task)}
          className="rounded-md px-2 py-1.5 text-xs text-mist-400 transition-colors hover:bg-rose-500/15 hover:text-danger sm:py-1"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
