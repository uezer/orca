import type { OrchestrationDb } from '../../orchestration/db'
import type {
  OrchestrationWorkerReadSource,
  OrchestrationWorkerReadResult
} from '../../../../shared/orchestration-worker-output'
import { readArchivedWorkerOutput } from './orchestration-worker-archive-read'

export function readFederatedArchivedWorkerOutput(args: {
  db: OrchestrationDb
  dispatchId: string
  source?: OrchestrationWorkerReadSource
  cursor?: string | number
  limit?: number
}): Promise<OrchestrationWorkerReadResult> {
  const resource = args.db.getWorkerTerminalResourceByOwner(args.dispatchId)
  if (!resource) {
    throw new Error(`No archived resource for federated Dispatch ${args.dispatchId}.`)
  }
  return readArchivedWorkerOutput({
    db: args.db,
    dispatchId: args.dispatchId,
    workerState: args.db.getWorkerDispatch(args.dispatchId)?.state ?? 'unknown',
    resource,
    source: args.source,
    cursor: args.cursor,
    limit: args.limit
  })
}
