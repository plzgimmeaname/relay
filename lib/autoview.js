// Terminal output for `relay auto` and `/auto`.
const { c, table, truncate, WIDTH } = require('./ui');
const { createPlan, runPlan, label } = require('./auto');
const { toolHint } = require('./tui');

const SOURCE = { tags: 'your [@cli] tags', local: 'local splitter' };

function renderPlan(plan) {
  const from = plan.source === 'planner' ? `split by ${plan.planner.backend}${plan.planner.model ? `:${plan.planner.model}` : ''}` : `split by ${SOURCE[plan.source]}`;
  const rows = plan.tasks.map((t) => [
    c.bold(t.id),
    truncate(t.title, 44),
    `${t.type}${t.writes ? '' : c.gray(' (read-only)')}`,
    t.difficulty,
    t.agent,
    c.cyan(label(t)),
    t.dependsOn.join(',') || c.gray('—'),
  ]);
  const head = `\n  ${c.bold(c.magenta('◆ Auto plan'))} ${c.gray(`${plan.tasks.length} task(s) · ${from}`)}\n`;
  const notes = plan.problems.length ? c.yellow(`  planner trouble: ${plan.problems.join(' · ')}\n`) : '';
  return `${head}${notes}\n${table(rows, ['id', 'task', 'type', 'level', 'agent', 'cli:model', 'after'], { width: Math.max(112, WIDTH()) })}\n`;
}

async function runAuto(app, instructions, opts) {
  const { log, out, control } = opts;
  const hooks = {
    onPlanning: (pick) => log(c.gray(`  ↳ planning with ${c.bold(pick.backend)}${pick.model ? `:${pick.model}` : ''} …`)),
  };
  const plan = await createPlan(app, instructions, hooks, opts);
  if (plan.aborted) {
    log(c.yellow('  ⏹  interrupted while planning'));
    return { ok: false, aborted: true };
  }
  log(renderPlan(plan));
  if (opts.dryRun) {
    log(c.gray('  dry run: nothing was executed\n'));
    return { ok: true, plan };
  }

  const done = await runPlan(
    app,
    plan,
    {
      onTaskStart: (t) => log(`${c.cyan(`  ▶ ${t.id}`)} ${c.bold(t.title)} ${c.gray(`→ ${t.agent} on ${label(t)}`)}`),
      onTaskEnd: (t, r) => {
        if (!r.ok) return log(c.red(`  ✗ ${t.id} ${r.error} on ${r.backend}`));
        log(c.green(`  ✓ ${t.id} done by ${r.backend}${r.model ? `:${r.model}` : ''}`));
        out(`\n${c.bold(`── ${t.id} · ${t.title}`)}\n${r.output.trim()}\n`);
      },
      onTaskSkipped: (t, dep) => log(c.yellow(`  ↷ ${t.id} skipped: ${dep} did not finish`)),
      onFailover: (t, { from, reason, next }) => log(c.yellow(`  ⚠ ${t.id} ${from}: ${reason}`) + c.gray(next ? ` → retrying on ${next}` : ' → no CLI left')),
      onEvent: (t, evt) => {
        if (evt.type === 'tool_use') log(c.gray(`    ${t.id} ⚙ ${evt.name} ${toolHint(evt.input)}`));
      },
    },
    opts,
  );

  const ok = done.results.filter((r) => r.ok).length;
  log((done.ok ? c.green : c.yellow)(`\n  ${done.ok ? '✓' : '!'} ${ok}/${done.results.length} tasks finished`));
  log(c.gray('  continue one: relay agent <agent> --attach\n'));
  return { ...done, plan };
}

module.exports = { runAuto, renderPlan };
