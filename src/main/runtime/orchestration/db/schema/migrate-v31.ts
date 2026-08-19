import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current < 31 && !this.hasColumn('remote_dispatch_attachments', 'host_scope')) {
    this.db.exec('ALTER TABLE remote_dispatch_attachments ADD COLUMN host_scope TEXT')
  }
}
