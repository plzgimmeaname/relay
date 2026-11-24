const { c, table, truncate, bullets } = require('./ui');

// Matches:
// 1. [@claude] or [@claude/sonnet] or [claude:sonnet]
// Step 1 [@claude]: ...
// @claude ... --- @qwen ...
// [claude] ... -> [qwen] ...
const BACKEND_TAG_RE = /\[@?([a-zA-Z0-9_-]+)(?::|\/)?([a-zA-Z0-9_.-]+)?\]/;
const BLOCK_SPLIT_RE = /\n\s*(?:---+|===+)\s*\n/;
const STEP_NUMBERED_RE = /^(?:(?:Step\s+)?(\d+)[\.:\)]|\*\s+Step\s+(\d+)[:\.]?)\s*(.*)/im;

// Model role mapping for intelligent auto-assignment when models aren't explicitly typed
const ROLE_ASSIGNMENTS = {
  plan: ['claude', 'agy', 'gemini', 'openai'],
  code: ['qwen', 'kilo', 'aider', 'copilot', 'cline', 'goose'],
  test: ['freebuff', 'junie', 'ollama', 'opencode', 'llm', 'openhands'],
  review: ['claude', 'agy', 'gemini', 'cody'],
};

function assignBestBackend(text, available = []) {
  const t = text.toLowerCase();
  let category = 'code';

  if (/plan|architect|design|analyze|spec|break down|outline/i.test(t)) {
    category = 'plan';
  } else if (/test|spec|verify|validate|assert|coverage|check/i.test(t)) {
    category = 'test';
  } else if (/review|audit|security|inspect|lint/i.test(t)) {
    category = 'review';
  }

  const preferred = ROLE_ASSIGNMENTS[category] || [];
  for (const name of preferred) {
    if (available.includes(name)) return name;
  }
  return available[0] || 'agy';
}

function parseMultiStepPrompt(input, availableBackends = []) {
  const text = String(input || '').trim();
  if (!text) return { isMultiStep: false, steps: [] };

  // 1. Check for explicit delimited blocks:
  // @claude
  // Do task 1
  // ---
  // @qwen
  // Do task 2
  if (BLOCK_SPLIT_RE.test(text)) {
    const rawBlocks = text.split(BLOCK_SPLIT_RE).map((b) => b.trim()).filter(Boolean);
    if (rawBlocks.length > 1) {
      const steps = rawBlocks.map((block, idx) => {
        let backend = null;
        let model = null;
        let body = block;

        const atMatch = block.match(/^@([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_.-]+))?\s*\n?([\s\S]*)$/);
        if (atMatch) {
          backend = atMatch[1];
          model = atMatch[2] || null;
          body = atMatch[3].trim();
        } else {
          const bracketMatch = block.match(/^\[@?([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_.-]+))?\]\s*([\s\S]*)$/);
          if (bracketMatch) {
            backend = bracketMatch[1];
            model = bracketMatch[2] || null;
            body = bracketMatch[3].trim();
          }
        }

        if (!backend) {
          backend = assignBestBackend(body, availableBackends);
        }

        return {
          stepNumber: idx + 1,
          backend,
          model,
          prompt: body,
          title: extractTitle(body, idx + 1),
        };
      });

      return { isMultiStep: true, type: 'delimited', steps };
    }
  }

  // 2. Check for pipeline arrows:
  // [claude] Plan architecture -> [qwen] Write code -> [freebuff] Write tests
  if (/\s+->\s+|\s+\|>\s+/.test(text) && (text.includes('[') || text.includes('@'))) {
    const segments = text.split(/\s*(?:->|\|>)\s*/).map((s) => s.trim()).filter(Boolean);
    if (segments.length > 1) {
      const steps = segments.map((seg, idx) => {
        let backend = null;
        let model = null;
        let body = seg;

        const m = seg.match(BACKEND_TAG_RE);
        if (m) {
          backend = m[1];
          model = m[2] || null;
          body = seg.replace(m[0], '').trim();
        } else {
          backend = assignBestBackend(body, availableBackends);
        }

        return {
          stepNumber: idx + 1,
          backend,
          model,
          prompt: body,
          title: extractTitle(body, idx + 1),
        };
      });

      return { isMultiStep: true, type: 'pipeline', steps };
    }
  }

  // 3. Check for numbered or Step X: patterns:
  // Step 1 [claude]: ...
  // Step 2 [qwen]: ...
  // or:
  // 1. [claude] ...
  // 2. [qwen] ...
  const lines = text.split('\n');
  const stepIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (/^(?:Step\s+\d+|[1-9]\d?[\.:\)])/i.test(l)) {
      stepIndices.push(i);
    }
  }

  if (stepIndices.length >= 2) {
    const steps = [];
    for (let k = 0; k < stepIndices.length; k += 1) {
      const start = stepIndices[k];
      const end = k + 1 < stepIndices.length ? stepIndices[k + 1] : lines.length;
      const block = lines.slice(start, end).join('\n').trim();
      const firstLine = lines[start].trim();

      let backend = null;
      let model = null;
      let body = block;

      // Extract [backend] or [@backend:model]
      const bMatch = block.match(BACKEND_TAG_RE);
      if (bMatch) {
        backend = bMatch[1];
        model = bMatch[2] || null;
        body = block.replace(bMatch[0], '').trim();
      }

      // Strip leading Step X / number prefix from prompt
      body = body.replace(/^(?:Step\s+\d+[:\.]?|[1-9]\d?[\.:\)])\s*/i, '').trim();

      if (!backend) {
        backend = assignBestBackend(body, availableBackends);
      }

      steps.push({
        stepNumber: k + 1,
        backend,
        model,
        prompt: body,
        title: extractTitle(body, k + 1),
      });
    }

    return { isMultiStep: true, type: 'numbered', steps };
  }

  return { isMultiStep: false, steps: [] };
}

function extractTitle(body, num) {
  const firstLine = String(body || '').trim().split('\n')[0] || `Step ${num}`;
  const clean = firstLine.replace(/^[#\-*>\s]+/, '').replace(/^Step\s+\d+[:\.]?\s*/i, '');
  return truncate(clean, 48);
}

async function executeMultiStep(app, pipeline, hooks = {}, opts = {}) {
  const steps = pipeline.steps;
  const results = [];
  let previousOutput = '';

  hooks.onPipelineStart?.({ totalSteps: steps.length, steps });

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const isFirst = i === 0;

    hooks.onStepStart?.({
      stepIndex: i,
      stepNumber: step.stepNumber,
      totalSteps: steps.length,
      step,
      backend: step.backend,
      model: step.model,
    });

    // Build context-aware prompt passing previous stage outputs
    let promptForStage = step.prompt;
    if (!isFirst && previousOutput) {
      promptForStage = [
        `## Multi-Step Workflow — Stage ${step.stepNumber} of ${steps.length}: ${step.title}`,
        `Assigned Model / Agent: ${step.backend}${step.model ? ` (${step.model})` : ''}`,
        '',
        `### Context from Previous Stage (Completed by ${steps[i - 1].backend}):`,
        previousOutput,
        '',
        `### Your Specific Instructions for Stage ${step.stepNumber}:`,
        step.prompt,
      ].join('\n');
    }

    const stepHooks = {
      onEvent: (evt, backend) => {
        hooks.onEvent?.(evt, backend, { stepIndex: i, step });
      },
    };

    const out = await app.turn(promptForStage, stepHooks, {
      force: step.backend,
      model: step.model,
      skipPipeline: true,
    });

    results.push({
      stepNumber: step.stepNumber,
      title: step.title,
      backend: out.backend || step.backend,
      model: step.model,
      ok: out.ok,
      res: out.res,
      output: out.res?.text || '',
    });

    hooks.onStepEnd?.({
      stepIndex: i,
      stepNumber: step.stepNumber,
      totalSteps: steps.length,
      step,
      backend: out.backend || step.backend,
      ok: out.ok,
      res: out.res,
    });

    if (!out.ok) {
      // If a step fails and failover couldn't resolve it, stop pipeline
      return {
        ok: false,
        isMultiStep: true,
        failedAtStep: step.stepNumber,
        results,
        res: out.res,
        backend: out.backend,
      };
    }

    previousOutput = out.res?.text || '';
  }

  const finalOutput = results[results.length - 1]?.output || '';
  const finalBackend = results[results.length - 1]?.backend || null;

  hooks.onPipelineComplete?.({
    totalSteps: steps.length,
    results,
    finalOutput,
    backend: finalBackend,
  });

  return {
    ok: true,
    isMultiStep: true,
    totalSteps: steps.length,
    results,
    res: results[results.length - 1]?.res,
    text: finalOutput,
    backend: finalBackend,
  };
}

module.exports = {
  parseMultiStepPrompt,
  executeMultiStep,
  assignBestBackend,
  ROLE_ASSIGNMENTS,
};
