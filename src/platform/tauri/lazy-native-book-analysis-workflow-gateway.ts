import type {
  BookAnalysisWorkflow,
  BookAnalysisWorkflowGateway,
  StartBookAnalysisWorkflowInput,
} from '../../features/ai/book-analysis-workflow-gateway';
import type { NativeBookWorkflowBridge } from '../../features/ai/native-workflow/contracts';
import type {
  NativeAnalysisWorkflowRepository,
  RevisionPinnedReaderRepository,
} from '../../repositories/reader-repository';

type NativeWorkflowRepository = RevisionPinnedReaderRepository & NativeAnalysisWorkflowRepository;

export class LazyNativeBookAnalysisWorkflowGateway implements BookAnalysisWorkflowGateway {
  readonly runtime = 'native' as const;
  readonly supportsTTSCacheReadiness = false;
  private gatewayPromise?: Promise<BookAnalysisWorkflowGateway>;

  constructor(
    private readonly bridge: NativeBookWorkflowBridge,
    private readonly repository: NativeWorkflowRepository,
  ) {}

  async getPlan(bookId: string, options = {}, signal?: AbortSignal): Promise<BookAnalysisWorkflow['plan']> {
    return (await this.gateway()).getPlan(bookId, options, signal);
  }

  async start(input: StartBookAnalysisWorkflowInput, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return (await this.gateway()).start(input, signal);
  }

  async get(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return (await this.gateway()).get(workflowId, signal);
  }

  async getActive(bookId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow | undefined> {
    return (await this.gateway()).getActive?.(bookId, signal);
  }

  async retry(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return (await this.gateway()).retry(workflowId, signal);
  }

  async cancel(workflowId: string, signal?: AbortSignal): Promise<BookAnalysisWorkflow> {
    return (await this.gateway()).cancel(workflowId, signal);
  }

  private gateway(): Promise<BookAnalysisWorkflowGateway> {
    this.gatewayPromise ??= import('../../features/ai/native-workflow/native-book-analysis-workflow-gateway').then(
      ({ NativeBookAnalysisWorkflowGateway }) => new NativeBookAnalysisWorkflowGateway(this.bridge, this.repository),
    );
    return this.gatewayPromise;
  }
}
