import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import { requiredString, OptionalFiniteNumber } from '../schemas'

export const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
export const WorkerReadParams = WorkerDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})
