import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineStage, type StageResult } from '../pipeline/types.js';

// --- Hoisted mocks (available during vi.mock factory execution) --------------

const {
  mockSend,
  mockHandleIntakeStage,
  mockHandleResearchStage,
  mockHandlePlanStage,
  mockHandleApproveStage,
  mockHandleExecuteStage,
  mockHandleVerifyStage,
  mockHandlePrStage,
  mockUpdatePipelineStage,
  mockPoolQuery,
  mockTrack,
  mockFlush,
  mockCreateSubTicket,
  mockUpdateTicketStatus,
} = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockHandleIntakeStage: vi.fn(),
  mockHandleResearchStage: vi.fn(),
  mockHandlePlanStage: vi.fn(),
  mockHandleApproveStage: vi.fn(),
  mockHandleExecuteStage: vi.fn(),
  mockHandleVerifyStage: vi.fn(),
  mockHandlePrStage: vi.fn(),
  mockUpdatePipelineStage: vi.fn(),
  mockPoolQuery: vi.fn(),
  mockTrack: vi.fn(),
  mockFlush: vi.fn(),
  mockCreateSubTicket: vi.fn(),
  mockUpdateTicketStatus: vi.fn(),
}));

// --- Module mocks ------------------------------------------------------------

vi.mock('@aws-sdk/client-sqs', () => {
  return {
    SQSClient: class MockSQSClient {
      config: Record<string, unknown>;
      send = mockSend;

      constructor(config: Record<string, unknown>) {
        this.config = config;
      }
    },
    SendMessageCommand: class MockSendMessageCommand {
      constructor(public readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('../pipeline/stages/intake.js', () => ({
  handleIntakeStage: mockHandleIntakeStage,
}));

vi.mock('../pipeline/stages/research.js', () => ({
  handleResearchStage: mockHandleResearchStage,
}));

vi.mock('../pipeline/stages/plan.js', () => ({
  handlePlanStage: mockHandlePlanStage,
}));

vi.mock('../pipeline/stages/approve.js', () => ({
  handleApproveStage: mockHandleApproveStage,
}));

vi.mock('../pipeline/stages/execute.js', () => ({
  handleExecuteStage: mockHandleExecuteStage,
}));

vi.mock('../pipeline/stages/verify.js', () => ({
  handleVerifyStage: mockHandleVerifyStage,
}));

vi.mock('../pipeline/stages/pr.js', () => ({
  handlePrStage: mockHandlePrStage,
}));

vi.mock('../pipeline/checkpoint.js', () => ({
  updatePipelineStage: mockUpdatePipelineStage,
}));

vi.mock('../analytics.js', () => ({
  track: mockTrack,
  flush: mockFlush,
}));

vi.mock('../integrations/linear.js', () => ({
  createSubTicket: mockCreateSubTicket,
  updateTicketStatus: mockUpdateTicketStatus,
}));

// --- Fixtures ----------------------------------------------------------------

const STAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/cah-dev-stages';

const MOCK_POOL = { query: mockPoolQuery } as unknown;
const MOCK_CLIENT = {} as unknown;
const MOCK_BUCKET = 'cah-artifacts';

const VALID_STAGE_MESSAGE = {
  runId: 'run-abc-123',
  projectId: 'project-abc',
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  stage: PipelineStage.Research,
  context: {
    featureDescription: 'Add user auth',
    phaseNumber: 1,
    phaseTotal: 3,
    previousArtifacts: [],
  },
};

const VALID_INTAKE_STAGE_MESSAGE = {
  ...VALID_STAGE_MESSAGE,
  stage: PipelineStage.Intake,
};

const VALID_PIPELINE_JOB_MESSAGE = {
  projectId: 'project-abc',
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  featureDescription: 'Add user auth',
};

const COMPLETED_RESULT: StageResult = {
  stage: PipelineStage.Research,
  status: 'completed',
  tasks: [],
};

const FAILED_RESULT: StageResult = {
  stage: PipelineStage.Research,
  status: 'failed',
  tasks: [],
  error: 'Research failed',
};

// --- Import under test (after mocks) ----------------------------------------

import { routeStage, StageRouterError } from '../pipeline/stage-router.js';
import type { Pool } from 'pg';
import type { DaytonaClient } from '../daytona-client.js';
import { SQSClient } from '@aws-sdk/client-sqs';

// --- Tests -------------------------------------------------------------------

describe('stage-router', () => {
  let pool: Pool;
  let client: DaytonaClient;
  let sqsClient: SQSClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockHandleIntakeStage.mockReset();
    mockHandleResearchStage.mockReset();
    mockHandlePlanStage.mockReset();
    mockHandleApproveStage.mockReset();
    mockHandleExecuteStage.mockReset();
    mockHandleVerifyStage.mockReset();
    mockHandlePrStage.mockReset();
    mockUpdatePipelineStage.mockReset();
    mockPoolQuery.mockReset();
    mockTrack.mockReset();
    mockFlush.mockReset();
    mockFlush.mockResolvedValue(undefined);
    mockCreateSubTicket.mockReset();
    mockUpdateTicketStatus.mockReset();

    pool = MOCK_POOL as Pool;
    client = MOCK_CLIENT as DaytonaClient;
    sqsClient = new SQSClient({});
  });

  // --- StageMessage routing ---------------------------------------------------

  describe('routeStage with StageMessage', () => {
    it('dispatches research StageMessage to handleResearchStage', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      const result = await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockHandleResearchStage).toHaveBeenCalledOnce();
      expect(result.stage).toBe(PipelineStage.Research);
      expect(result.status).toBe('completed');
    });

    it('dispatches intake StageMessage to handleIntakeStage (not other handlers)', async () => {
      const intakeResult: StageResult = {
        stage: PipelineStage.Intake,
        status: 'completed',
        tasks: [],
      };
      mockHandleIntakeStage.mockResolvedValueOnce(intakeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_INTAKE_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockHandleIntakeStage).toHaveBeenCalledOnce();
      expect(mockHandleResearchStage).not.toHaveBeenCalled();
      expect(mockHandlePlanStage).not.toHaveBeenCalled();
      expect(mockHandleApproveStage).not.toHaveBeenCalled();
      expect(mockHandleExecuteStage).not.toHaveBeenCalled();
      expect(mockHandleVerifyStage).not.toHaveBeenCalled();
      expect(mockHandlePrStage).not.toHaveBeenCalled();
    });
  });

  // --- PipelineJobMessage routing ---------------------------------------------

  describe('routeStage with PipelineJobMessage', () => {
    it('generates UUID runId, constructs intake StageMessage, calls handleIntakeStage', async () => {
      const intakeResult: StageResult = {
        stage: PipelineStage.Intake,
        status: 'completed',
        tasks: [],
      };
      mockHandleIntakeStage.mockResolvedValueOnce(intakeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_PIPELINE_JOB_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockHandleIntakeStage).toHaveBeenCalledOnce();

      // Verify the constructed StageMessage has a UUID runId
      const calledMsg = mockHandleIntakeStage.mock.calls[0][0];
      expect(calledMsg.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(calledMsg.stage).toBe(PipelineStage.Intake);
      expect(calledMsg.projectId).toBe('project-abc');
      expect(calledMsg.repoUrl).toBe('https://github.com/org/repo.git');
      expect(calledMsg.branch).toBe('main');
    });

    it('passes featureDescription into context', async () => {
      const intakeResult: StageResult = {
        stage: PipelineStage.Intake,
        status: 'completed',
        tasks: [],
      };
      mockHandleIntakeStage.mockResolvedValueOnce(intakeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_PIPELINE_JOB_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      const calledMsg = mockHandleIntakeStage.mock.calls[0][0];
      expect(calledMsg.context.featureDescription).toBe('Add user auth');
      expect(calledMsg.context.phaseNumber).toBe(1);
      expect(calledMsg.context.phaseTotal).toBe(1);
      expect(calledMsg.context.previousArtifacts).toEqual([]);
    });
  });

  // --- Post-handler behavior --------------------------------------------------

  describe('post-handler behavior', () => {
    it('calls updatePipelineStage after handler completes', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockUpdatePipelineStage).toHaveBeenCalledOnce();
      expect(mockUpdatePipelineStage).toHaveBeenCalledWith(
        pool,
        'run-abc-123',
        PipelineStage.Plan, // next stage after Research
      );
    });

    it('sends SQS message for next stage when status is completed', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockSend).toHaveBeenCalledOnce();
      const command = mockSend.mock.calls[0][0];
      expect(command.input.QueueUrl).toBe(STAGE_QUEUE_URL);

      const sentBody = JSON.parse(command.input.MessageBody as string);
      expect(sentBody.stage).toBe(PipelineStage.Plan);
      expect(sentBody.runId).toBe('run-abc-123');
    });

    it('does NOT send SQS message when stage is PR (terminal)', async () => {
      const prMsg = { ...VALID_STAGE_MESSAGE, stage: PipelineStage.PR };
      const prResult: StageResult = {
        stage: PipelineStage.PR,
        status: 'completed',
        tasks: [],
      };
      mockHandlePrStage.mockResolvedValueOnce(prResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);

      await routeStage(
        JSON.stringify(prMsg),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('does NOT send SQS message when handler returns failed', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(FAILED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);

      await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // --- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('throws StageRouterError on invalid JSON', async () => {
      try {
        await routeStage(
          'not valid json {{{',
          pool,
          client,
          MOCK_BUCKET,
          STAGE_QUEUE_URL,
          sqsClient,
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StageRouterError);
        const routerErr = err as StageRouterError;
        expect(routerErr.operation).toBe('routeStage');
        expect(routerErr.message).toContain('parse message body');
      }
    });

    it('throws StageRouterError when message matches neither schema', async () => {
      try {
        await routeStage(
          JSON.stringify({ randomField: 'value' }),
          pool,
          client,
          MOCK_BUCKET,
          STAGE_QUEUE_URL,
          sqsClient,
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StageRouterError);
        const routerErr = err as StageRouterError;
        expect(routerErr.operation).toBe('routeStage');
        expect(routerErr.message).toContain('neither StageMessage nor PipelineJobMessage');
      }
    });
  });

  // --- Paused status handling --------------------------------------------------

  describe('paused status handling', () => {
    it('updates pipeline status to paused and does NOT send SQS message when handler returns paused', async () => {
      const approveMsg = { ...VALID_STAGE_MESSAGE, stage: PipelineStage.Approve };
      const pausedResult: StageResult = {
        stage: PipelineStage.Approve,
        status: 'paused',
        tasks: [],
      };
      mockHandleApproveStage.mockResolvedValueOnce(pausedResult);

      await routeStage(
        JSON.stringify(approveMsg),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      // Should update pipeline_runs to 'paused'
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("status = 'paused'"),
        [PipelineStage.Approve, 'run-abc-123'],
      );

      // Should NOT advance via SQS
      expect(mockSend).not.toHaveBeenCalled();

      // Should NOT call updatePipelineStage
      expect(mockUpdatePipelineStage).not.toHaveBeenCalled();
    });
  });

  // --- D-10 Linear sub-ticket lifecycle --------------------------------------

  describe('D-10 Linear sub-ticket lifecycle', () => {
    const EXECUTE_MSG_WITH_LINEAR = {
      ...VALID_STAGE_MESSAGE,
      stage: PipelineStage.Execute,
      context: {
        ...VALID_STAGE_MESSAGE.context,
        linearParentTicketId: 'linear-parent-123',
      },
    };

    it('calls createSubTicket at execute stage entry when linearParentTicketId is present', async () => {
      const executeResult: StageResult = {
        stage: PipelineStage.Execute,
        status: 'completed',
        tasks: [],
      };
      mockHandleExecuteStage.mockResolvedValueOnce(executeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});
      mockCreateSubTicket.mockResolvedValueOnce({ ticketId: 'sub-ticket-456', identifier: 'CAH-42' });
      mockUpdateTicketStatus.mockResolvedValue(undefined);

      await routeStage(
        JSON.stringify(EXECUTE_MSG_WITH_LINEAR),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockCreateSubTicket).toHaveBeenCalledOnce();
      expect(mockCreateSubTicket).toHaveBeenCalledWith(
        'linear-parent-123',
        1,
        'Phase 1',
      );
    });

    it('calls updateTicketStatus in_progress after sub-ticket creation at execute entry', async () => {
      const executeResult: StageResult = {
        stage: PipelineStage.Execute,
        status: 'completed',
        tasks: [],
      };
      mockHandleExecuteStage.mockResolvedValueOnce(executeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});
      mockCreateSubTicket.mockResolvedValueOnce({ ticketId: 'sub-ticket-456', identifier: 'CAH-42' });
      mockUpdateTicketStatus.mockResolvedValue(undefined);

      await routeStage(
        JSON.stringify(EXECUTE_MSG_WITH_LINEAR),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      // First updateTicketStatus call should be for the sub-ticket at entry
      expect(mockUpdateTicketStatus).toHaveBeenCalledWith('sub-ticket-456', 'in_progress');
    });

    it('calls updateTicketStatus on successful stage transition when linearParentTicketId present', async () => {
      const researchMsg = {
        ...VALID_STAGE_MESSAGE,
        stage: PipelineStage.Research,
        context: {
          ...VALID_STAGE_MESSAGE.context,
          linearParentTicketId: 'linear-parent-123',
        },
      };
      const completedResult: StageResult = {
        stage: PipelineStage.Research,
        status: 'completed',
        tasks: [],
      };
      mockHandleResearchStage.mockResolvedValueOnce(completedResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});
      mockUpdateTicketStatus.mockResolvedValue(undefined);

      await routeStage(
        JSON.stringify(researchMsg),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockUpdateTicketStatus).toHaveBeenCalledWith('linear-parent-123', 'in_progress');
    });

    it('does not throw when createSubTicket fails (non-critical)', async () => {
      const executeResult: StageResult = {
        stage: PipelineStage.Execute,
        status: 'completed',
        tasks: [],
      };
      mockHandleExecuteStage.mockResolvedValueOnce(executeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});
      mockCreateSubTicket.mockRejectedValueOnce(new Error('Linear API down'));
      mockUpdateTicketStatus.mockResolvedValue(undefined);

      // Should NOT throw -- sub-ticket creation is non-critical
      const result = await routeStage(
        JSON.stringify(EXECUTE_MSG_WITH_LINEAR),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(result.status).toBe('completed');
    });

    it('does not call createSubTicket for non-execute stages', async () => {
      const researchMsg = {
        ...VALID_STAGE_MESSAGE,
        stage: PipelineStage.Research,
        context: {
          ...VALID_STAGE_MESSAGE.context,
          linearParentTicketId: 'linear-parent-123',
        },
      };
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});
      mockUpdateTicketStatus.mockResolvedValue(undefined);

      await routeStage(
        JSON.stringify(researchMsg),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockCreateSubTicket).not.toHaveBeenCalled();
    });
  });

  // --- PostHog tracking -------------------------------------------------------

  describe('PostHog tracking', () => {
    it('calls track with stage_completed after handler returns', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockTrack).toHaveBeenCalledWith('stage_completed', {
        runId: 'run-abc-123',
        projectId: 'project-abc',
        stage: PipelineStage.Research,
        status: 'completed',
      });
    });

    it('calls flush before returning', async () => {
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_STAGE_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockFlush).toHaveBeenCalledOnce();
    });
  });

  // --- planningPrefix forwarding -----------------------------------------------

  describe('jobMessageToIntakeStageMessage planningPrefix forwarding', () => {
    it('forwards planningPrefix from PipelineJobMessage to StageMessage context', async () => {
      const intakeResult: StageResult = {
        stage: PipelineStage.Intake,
        status: 'completed',
        tasks: [],
      };
      mockHandleIntakeStage.mockResolvedValueOnce(intakeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      const jobWithPrefix = {
        ...VALID_PIPELINE_JOB_MESSAGE,
        planningPrefix: 'triggers/abc-123/planning/',
      };

      await routeStage(
        JSON.stringify(jobWithPrefix),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockHandleIntakeStage).toHaveBeenCalledOnce();
      const calledMsg = mockHandleIntakeStage.mock.calls[0][0];
      expect(calledMsg.context.planningPrefix).toBe('triggers/abc-123/planning/');
    });

    it('sets planningPrefix to undefined when not provided in PipelineJobMessage', async () => {
      const intakeResult: StageResult = {
        stage: PipelineStage.Intake,
        status: 'completed',
        tasks: [],
      };
      mockHandleIntakeStage.mockResolvedValueOnce(intakeResult);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      await routeStage(
        JSON.stringify(VALID_PIPELINE_JOB_MESSAGE),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      expect(mockHandleIntakeStage).toHaveBeenCalledOnce();
      const calledMsg = mockHandleIntakeStage.mock.calls[0][0];
      expect(calledMsg.context.planningPrefix).toBeUndefined();
    });
  });

  // --- Type guard tests -------------------------------------------------------

  describe('type guard disambiguation', () => {
    it('isPipelineJobMessage returns false for StageMessage (has stage field)', async () => {
      // A StageMessage has a 'stage' field, which means isPipelineJobMessage
      // should return false (it checks stage === undefined).
      // We verify this by sending a StageMessage and confirming it routes
      // to the StageMessage path (not the PipelineJobMessage intake path).
      mockHandleResearchStage.mockResolvedValueOnce(COMPLETED_RESULT);
      mockUpdatePipelineStage.mockResolvedValueOnce(undefined);
      mockSend.mockResolvedValueOnce({});

      // This StageMessage also has featureDescription in context,
      // so without the stage===undefined check, it could match both guards
      const ambiguousMessage = {
        ...VALID_STAGE_MESSAGE,
        featureDescription: 'Could match PipelineJobMessage without stage check',
      };

      await routeStage(
        JSON.stringify(ambiguousMessage),
        pool,
        client,
        MOCK_BUCKET,
        STAGE_QUEUE_URL,
        sqsClient,
      );

      // Should route to handleResearchStage, not handleIntakeStage
      expect(mockHandleResearchStage).toHaveBeenCalledOnce();
      expect(mockHandleIntakeStage).not.toHaveBeenCalled();
    });
  });
});
