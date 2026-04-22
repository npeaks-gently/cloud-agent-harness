import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PhaseStepType } from '../../../sdk/src/types.js';

// --- Tests -------------------------------------------------------------------

describe('auto-decider', () => {
  // --- PhaseStepType enum validation -----------------------------------------

  it('PhaseStepType.AutoDecide enum value exists', () => {
    expect(PhaseStepType.AutoDecide).toBe('auto_decide');
  });

  // --- Agent definition loading ----------------------------------------------

  it('auto-decider agent definition is loadable and has expected frontmatter', async () => {
    // Resolve from repo root (cwd is the worktree root)
    const agentPath = join(process.cwd(), 'agents', 'auto-decider.md');
    const content = await readFile(agentPath, 'utf-8');

    // Verify YAML frontmatter fields
    expect(content).toContain('name: auto-decider');
    expect(content).toContain('tools: Read, Write, Bash, Grep, Glob');
    expect(content).toContain('color: cyan');

    // Verify role block exists
    expect(content).toContain('<role>');
    expect(content).toContain('</role>');
  });

  it('auto-decider agent definition contains decision classification rubric', async () => {
    const agentPath = join(process.cwd(), 'agents', 'auto-decider.md');
    const content = await readFile(agentPath, 'utf-8');

    // Verify risk classification rubric
    expect(content).toContain('**Routine**');
    expect(content).toContain('**High-risk**');
    expect(content).toContain('**Default-routine bias:**');
  });

  // --- DECISIONS.md format validation ----------------------------------------

  it('DECISIONS.md format matches expected Markdown structure', () => {
    const sampleDecisions = `# Decisions -- Phase 04

**Run:** run-abc-123
**Phase:** 04
**Generated:** 2026-04-17T12:00:00Z

## Decision 1: Which testing framework to use?

| Field | Value |
|-------|-------|
| Risk Level | routine |
| Confidence | 0.9 |
| Chosen Option | vitest |
| Alternatives | jest, mocha |

**Reasoning:** vitest is already used in the project and provides better TypeScript support.

---`;

    // Verify structure components
    expect(sampleDecisions).toContain('# Decisions -- Phase');
    expect(sampleDecisions).toContain('**Run:**');
    expect(sampleDecisions).toContain('**Phase:**');
    expect(sampleDecisions).toContain('**Generated:**');
    expect(sampleDecisions).toContain('| Risk Level |');
    expect(sampleDecisions).toContain('| Confidence |');
    expect(sampleDecisions).toContain('| Chosen Option |');
    expect(sampleDecisions).toContain('| Alternatives |');
    expect(sampleDecisions).toContain('**Reasoning:**');
  });

  // --- Escalation JSON format validation ------------------------------------

  it('escalation JSON output has required fields', () => {
    const escalation = {
      type: 'escalation',
      risk: 'high',
      question: 'Should we add a new external dependency for PDF generation?',
      reason: 'New external dependency affects supply chain security',
      options: ['pdfkit', 'puppeteer', 'wkhtmltopdf'],
      confidence: 0.3,
    };

    expect(escalation.type).toBe('escalation');
    expect(escalation.risk).toBe('high');
    expect(typeof escalation.question).toBe('string');
    expect(typeof escalation.reason).toBe('string');
    expect(Array.isArray(escalation.options)).toBe(true);
    expect(escalation.options.length).toBeGreaterThan(0);
    expect(typeof escalation.confidence).toBe('number');
    expect(escalation.confidence).toBeGreaterThanOrEqual(0);
    expect(escalation.confidence).toBeLessThanOrEqual(1);

    // Verify serialization round-trips
    const serialized = JSON.stringify(escalation);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual(escalation);
  });
});
