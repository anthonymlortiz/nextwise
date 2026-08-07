import { useMemo } from 'react';
import type { Domain, FocusLevel, Project, ScoredTask, Situation, Task, TaskContext } from '../types';
import { CONTEXTS, CONTEXT_LABEL, FOCUS_LABEL } from '../types';
import { buildSessionPlan, recommend, withheld } from '../recommender';
import { indexTasks } from '../availability';
import { Button, Card, SectionTitle, Select } from '../ui';
import { formatMinutes } from '../styles';
import { TaskRow } from './TaskRow';

const TIME_PRESETS = [15, 25, 45, 60, 90, 120, 180];

function ReasonList({ reasons }: { reasons: ScoredTask['reasons'] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {reasons.map((r) => (
        <span key={r.label} className="text-[11px] leading-none text-mist-500">
          {r.label}{' '}
          <span
            className={`tnum font-semibold ${
              r.points >= 0 ? 'text-good' : 'text-danger'
            }`}
          >
            {r.points >= 0 ? '+' : ''}
            {r.points}
          </span>
        </span>
      ))}
    </div>
  );
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-xl border border-line bg-ink-900/50 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-150 ${
            value === o.value
              ? 'bg-accent-500 text-white shadow-sm shadow-accent-500/25'
              : 'text-mist-400 hover:bg-raise-2 hover:text-mist-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FocusPanel({
  tasks,
  projects,
  ctx,
  onCtxChange,
  onToggle,
  onEdit,
  onDelete,
  onStart,
}: {
  tasks: Task[];
  projects: Project[];
  ctx: Situation;
  onCtxChange: (ctx: Situation) => void;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onStart: (task: Task) => void;
}) {
  const scored = useMemo(() => recommend(tasks, ctx), [tasks, ctx]);
  const plan = useMemo(() => buildSessionPlan(scored, ctx.availableMin), [scored, ctx.availableMin]);
  const hidden = useMemo(() => withheld(tasks, ctx), [tasks, ctx]);
  const byId = useMemo(() => indexTasks(tasks), [tasks]);
  const hiddenTotal = hidden.blocked + hidden.deferred + hidden.wrongContext;

  const projectOf = (t: Task) => projects.find((p) => p.id === t.projectId);
  const set = (patch: Partial<Situation>) => onCtxChange({ ...ctx, ...patch });

  const top = scored[0];
  const rest = scored.slice(1);
  const visibleProjects = projects.filter(
    (p) => !p.archived && (ctx.domain === 'both' || p.domain === ctx.domain),
  );

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="h-fit p-5">
        <SectionTitle hint="jAIme needs four answers">Right now</SectionTitle>

        <div className="mt-4 grid gap-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
                Time available
              </span>
              <span className="text-sm font-semibold text-fg">
                {formatMinutes(ctx.availableMin)}
              </span>
            </div>
            <input
              type="range"
              min={5}
              max={240}
              step={5}
              value={ctx.availableMin}
              onChange={(e) => set({ availableMin: Number(e.target.value) })}
              className="w-full"
              style={{ '--pct': `${((ctx.availableMin - 5) / 235) * 100}%` } as React.CSSProperties}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TIME_PRESETS.map((m) => (
                <button
                  key={m}
                  onClick={() => set({ availableMin: m })}
                  className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                    ctx.availableMin === m
                      ? 'border-accent-400/60 bg-accent-500/20 font-medium text-fg'
                      : 'border-line text-mist-400 hover:border-line-strong hover:bg-raise-2 hover:text-mist-200'
                  }`}
                >
                  {formatMinutes(m)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-2 block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
              Focus level
            </span>
            <Segmented<FocusLevel>
              value={ctx.focus}
              onChange={(focus) => set({ focus })}
              options={[
                { value: 'shallow', label: 'Drained' },
                { value: 'medium', label: 'Okay' },
                { value: 'deep', label: 'Sharp' },
              ]}
            />
            <p className="mt-1.5 text-[11px] text-mist-500">{FOCUS_LABEL[ctx.focus]}</p>
          </div>

          <div>
            <span className="mb-2 block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
              Area
            </span>
            <Segmented<Domain | 'both'>
              value={ctx.domain}
              onChange={(domain) => set({ domain, projectId: 'all' })}
              options={[
                { value: 'work', label: 'Work' },
                { value: 'personal', label: 'Personal' },
                { value: 'both', label: 'Both' },
              ]}
            />
          </div>

          <div>
            <span className="mb-2 block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
              Where you are
            </span>
            <Select
              className="w-full"
              value={ctx.context ?? 'any'}
              onChange={(e) => set({ context: e.target.value as TaskContext | 'any' })}
            >
              <option value="any">Anywhere</option>
              {CONTEXTS.map((c) => (
                <option key={c} value={c}>
                  {CONTEXT_LABEL[c]}
                </option>
              ))}
            </Select>
            {ctx.context && ctx.context !== 'any' && (
              <p className="mt-1.5 text-[11px] text-mist-500">
                Tasks needing somewhere else are hidden. Anything without a context still
                counts.
              </p>
            )}
          </div>

          <div>
            <span className="mb-2 block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
              Project
            </span>
            <Select
              className="w-full"
              value={ctx.projectId ?? 'all'}
              onChange={(e) =>
                set({ projectId: e.target.value === 'all' ? 'all' : Number(e.target.value) })
              }
            >
              <option value="all">All projects</option>
              {visibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {hiddenTotal > 0 && (
          // A ranking is only trustworthy if it can account for what it left
          // out, not just for what it put first.
          <p data-withheld className="mt-4 border-t border-line-soft pt-3 text-[11px] leading-relaxed text-mist-500">
            {hiddenTotal} task{hiddenTotal === 1 ? '' : 's'} held back:{' '}
            {[
              hidden.blocked && `${hidden.blocked} blocked`,
              hidden.deferred && `${hidden.deferred} not startable yet`,
              hidden.wrongContext && `${hidden.wrongContext} needs somewhere else`,
            ]
              .filter(Boolean)
              .join(' · ')}
            .
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5">
        {!top ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-mist-400">
              {hiddenTotal > 0
                ? 'Everything here is blocked, deferred, or needs you somewhere else. Widen the filters, or unblock something.'
                : 'Nothing matches this context. jAIme needs a wider area filter or more tasks.'}
            </p>
          </Card>
        ) : (
          <>
            <Card className="overflow-hidden ring-1 ring-accent-500/20">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-gradient-to-r from-accent-500/[0.14] via-accent-500/[0.06] to-transparent px-5 py-3">
                <SectionTitle
                  hint={
                    <span className="tnum rounded-md bg-raise-2 px-2 py-1 font-medium text-mist-300">
                      match score {Math.round(top.score)}
                    </span>
                  }
                >
                  jAIme recommends
                </SectionTitle>
              </div>
              <div className="p-3 sm:p-4">
                <TaskRow
                  task={top.task}
                  project={projectOf(top.task)}
                  byId={byId}
                  onToggle={onToggle}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  trailing={<ReasonList reasons={top.reasons} />}
                />
                {top.overBudget && (
                  <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/[0.08] px-3 py-2 text-xs leading-relaxed text-warn">
                    Even your best match is longer than the time you have. Consider making a
                    smaller next-step task, or extend the window.
                  </p>
                )}
                {/* The whole point of a recommendation is the next click after
                    it, so Start is the loudest control on the page. */}
                <div className="mt-3 flex items-center gap-3 border-t border-line-soft px-1 pt-3">
                  <Button
                    variant="primary"
                    data-start-task={top.task.title}
                    onClick={() => onStart(top.task)}
                    className="px-5 py-2"
                  >
                    Start
                  </Button>
                  <span className="text-[11px] text-mist-500">
                    Clears the board and starts a {formatMinutes(top.task.estimateMin)} clock.
                  </span>
                </div>
              </div>
            </Card>

            <Card className="p-5">
              <SectionTitle
                hint={`${formatMinutes(plan.usedMin)} planned · ${formatMinutes(plan.leftoverMin)} spare`}
              >
                Session plan for {formatMinutes(ctx.availableMin)}
              </SectionTitle>
              {plan.items.length === 0 ? (
                <p className="mt-3 text-sm text-mist-400">
                  No task fits in {formatMinutes(ctx.availableMin)}. Break something down or give
                  yourself a longer block.
                </p>
              ) : (
                <ol className="mt-3.5 grid gap-1">
                  {plan.items.map((item, i) => (
                    <li
                      key={item.task.id}
                      className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-raise-1"
                    >
                      <span className="tnum flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-raise-1 text-[11px] font-semibold text-mist-300">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1 truncate text-sm text-mist-200">
                        {item.task.title}
                      </div>
                      <button
                        data-start-task={item.task.title}
                        onClick={() => onStart(item.task)}
                        className="reveal shrink-0 rounded-md px-2 py-1 text-xs text-mist-400 transition-opacity hover:bg-raise-3 hover:text-fg"
                      >
                        Start
                      </button>
                      <span className="tnum shrink-0 text-xs text-mist-500">
                        {formatMinutes(item.task.estimateMin)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>

            {rest.length > 0 && (
              <Card className="p-3 sm:p-4">
                <div className="px-2 pb-1 pt-1">
                  <SectionTitle hint={`${rest.length} more`}>Ranked alternatives</SectionTitle>
                </div>
                <div className="mt-1 divide-y divide-line-soft">
                  {rest.map((item) => (
                    <TaskRow
                      key={item.task.id}
                      task={item.task}
                      project={projectOf(item.task)}
                      byId={byId}
                      onToggle={onToggle}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      trailing={<ReasonList reasons={item.reasons} />}
                      onStart={onStart}
                    />
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
